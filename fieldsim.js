/**
 * fieldsim.js — full-field drive/play sim for the Projector Board
 * Vanilla JS, no frameworks. League-aware via window.BOARD_LEAGUE ("college-football" | "nfl").
 *
 * The FIELD ARTWORK is Carson's Illustrator design (field.svg, 1280x332, goal lines at x=106/1172).
 * This module renders ONLY the live layer on top of that art:
 *   - the ball / line of scrimmage, sliding to each new spot
 *   - every scrimmage play as a colored segment of the yards gained:
 *       RUN = amber, PASS(complete) = cyan, INCOMPLETE = faded tick,
 *       SACK/loss = red, PENALTY = gold, TURNOVER = magenta
 *   - the first-down line
 * The ticker band shows the scoreboard: score · clock · down&distance · last-play chip.
 *
 * Field coordinates (SVG overlay shares field.svg's 1280x332 viewBox, preserveAspectRatio="none"):
 *   possessing team always drives LEFT -> RIGHT toward x=XG_R.
 *   x = XG_L + (100 - yardsToEndzone)/100 * (XG_R - XG_L)
 *   (yardsToEndzone = yards to the possessing team's scoring end zone; lines up with the printed numbers)
 *
 * Data: ESPN game summary (CORS-open):
 *   https://site.api.espn.com/apis/site/v2/sports/football/<lg>/summary?event=<id>
 *     .header.competitions[0] : competitors[] (team, score, homeAway), status (clock/period/state)
 *     .drives.current / .drives.previous[] : drive .team + .plays[]
 *        play.type.text, play.start.{down,distance,yardsToEndzone,downDistanceText},
 *        play.end.yardsToEndzone, play.statYardage, play.scoringPlay
 *
 * Public API:
 *   mountFieldSim(container, eventId, opts)   opts: { scoreEl, demo, onEmpty, onError }
 *   stopFieldSim()
 * Security: API strings assigned via textContent / known-safe SVG attrs; no innerHTML with feed data.
 */
(function (root) {
  "use strict";

  function _lg(){ return (typeof window !== "undefined" && window.BOARD_LEAGUE) || "college-football"; }
  function _sumUrl(id){ return "https://site.api.espn.com/apis/site/v2/sports/football/" + _lg() + "/summary?event=" + encodeURIComponent(id); }

  const SVGNS = "http://www.w3.org/2000/svg";
  // field.svg coordinate system (measured from Carson's artwork)
  const VBW=1280, VBH=332, XG_L=106, XG_R=1172, YMID=166, SPAN=XG_R-XG_L;

  // High-contrast play colors tuned to read against the green turf
  const COL = {
    run:  "#FF2A1A",                 // red
    pass: "#2438E6",                 // dark saturated blue
    inc:  "rgba(36,56,230,0.5)",     // faded blue (incomplete pass)
    sack: "#FF8A00",                 // orange (loss — distinct from the red run)
    pen:  "#FFD400",                 // gold (also the first-down line)
    to:   "#C026D3",                 // purple (turnover)
    st:   "#e6e9ee",                 // near-white (special teams)
    td:   "#ffffff",                 // white accent on a scoring play
  };

  let _wrap=null, _svg=null, _scoreEl=null, _active=false, _timer=null, _eventId=null;
  let _demo=false, _demoTimer=null, _opts={};
  let _lastSig="";

  function _el(tag, css, cls){ const e=document.createElement(tag); if(css) e.style.cssText=css; if(cls) e.className=cls; return e; }
  function _svgel(tag, attrs){ const e=document.createElementNS(SVGNS, tag); if(attrs) for(const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function _tc(hex){ // team hex -> {bg, text} lightened for a dim projector (mirrors cfb.html teamColors)
    let n=parseInt((hex||"888888").replace(/^#/,""),16); if(isNaN(n)) n=0x888888;
    let r=(n>>16)&255,g=(n>>8)&255,b=n&255; const L0=0.299*r+0.587*g+0.114*b;
    if(L0<95){ const f=95/Math.max(L0,1); r=Math.min(255,r*f); g=Math.min(255,g*f); b=Math.min(255,b*f); }
    const L=0.299*r+0.587*g+0.114*b; return { bg:"rgb("+(r|0)+","+(g|0)+","+(b|0)+")", text:L>150?"#111":"#fff" };
  }

  // ── play classification ────────────────────────────────────────────────────
  function playCat(txt){
    const t=(txt||"").toLowerCase();
    if(t.indexOf("sack")>=0) return "sack";
    if(t.indexOf("rush")>=0) return "run";
    if(t.indexOf("incompl")>=0) return "inc";
    if(t.indexOf("fumble")>=0 || t.indexOf("intercept")>=0) return "to";
    if(t.indexOf("pass")>=0 || t.indexOf("reception")>=0) return "pass";
    if(t.indexOf("penalty")>=0) return "pen";
    if(t.indexOf("punt")>=0 || t.indexOf("kickoff")>=0 || t.indexOf("field goal")>=0) return "st";
    return "other";
  }
  function isScrimmage(cat){ return cat==="run"||cat==="pass"||cat==="inc"||cat==="sack"||cat==="pen"||cat==="to"; }
  function xAt(toEnd){ const te=(toEnd==null?50:Math.max(0,Math.min(100,toEnd))); return XG_L + (100-te)/100*SPAN; }

  // ── overlay scaffold (the field itself is the CSS background = field.svg) ─────
  function buildOverlay(container){
    container.replaceChildren();
    // field art as the background, stretched to the zone (aspect already matches -> no distortion).
    // NB: #fieldsim keeps its CSS `position:absolute;inset:0` (fills the main box + anchors the overlay) — don't override position here.
    container.style.cssText = "overflow:hidden;background:#0a0f0b url('field.svg') center/100% 100% no-repeat;";

    const svg=_svgel("svg",{ viewBox:"0 0 "+VBW+" "+VBH, preserveAspectRatio:"none",
      style:"position:absolute;inset:0;width:100%;height:100%;z-index:1;" });
    _svg=svg;
    svg.appendChild(_svgel("g",{ id:"fs-plays" }));
    // first-down line (full height, thick gold)
    svg.appendChild(_svgel("line",{ id:"fs-first", x1:0,y1:0,x2:0,y2:VBH, stroke:COL.pen, "stroke-width":8,
      style:"opacity:0;transition:all .55s cubic-bezier(.34,.85,.3,1);" }));
    // line of scrimmage (full height)
    svg.appendChild(_svgel("line",{ id:"fs-los", x1:0,y1:0,x2:0,y2:VBH, stroke:"rgba(255,255,255,0.95)","stroke-width":3.5,
      style:"transition:all .55s cubic-bezier(.34,.85,.3,1);" }));
    // ball (football) at the LOS
    const ball=_svgel("ellipse",{ id:"fs-ball", cx:XG_L, cy:YMID, rx:15, ry:9, fill:"#8a4b1f", stroke:"#f4e3c4",
      "stroke-width":2.4, style:"transition:all .55s cubic-bezier(.34,.85,.3,1);filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));" });
    svg.appendChild(ball);
    // a thin lace on the ball
    svg.appendChild(_svgel("line",{ id:"fs-lace", x1:XG_L-5,y1:YMID,x2:XG_L+5,y2:YMID, stroke:"#f4e3c4","stroke-width":1.4,
      style:"transition:all .55s cubic-bezier(.34,.85,.3,1);" }));
    container.appendChild(svg);
  }

  // ── render one drive's plays + markers ───────────────────────────────────────
  function renderDrive(drive, animateNewest){
    if(!_svg) return;
    const layer=_svg.querySelector("#fs-plays"); if(!layer) return;
    const plays=(drive&&drive.plays)||[];
    const scrim=plays.filter(function(p){ return isScrimmage(playCat((p.type&&p.type.text)||"")); });
    layer.replaceChildren();

    scrim.forEach(function(p, i){
      const cat=playCat((p.type&&p.type.text)||"");
      const s=p.start||{}, e=p.end||{};
      const x1=xAt(s.yardsToEndzone), x2=xAt(e.yardsToEndzone);
      const newest=(i===scrim.length-1);
      const col=COL[cat]||COL.st;
      if(cat==="inc"){
        const tick=_svgel("line",{ x1:x1,y1:YMID-30,x2:x1,y2:YMID+30, stroke:col, "stroke-width":3.5,
          "stroke-dasharray":"7 7" }); layer.appendChild(tick);
      } else {
        const a=Math.min(x1,x2), b=Math.max(x1,x2), w=Math.max(7,b-a);
        const seg=_svgel("rect",{ x:a, y:YMID-13, width:w, height:26, rx:9, fill:col, opacity: newest?0.98:0.72 });
        if(newest){ seg.setAttribute("stroke","rgba(255,255,255,0.85)"); seg.setAttribute("stroke-width",1.6);
          if(animateNewest) seg.style.cssText="transform-box:fill-box;transform-origin:"+(x2<x1?"right":"left")+" center;animation:fs-grow .6s ease-out both;"; }
        layer.appendChild(seg);
        if(newest){ // direction arrowhead at the end of the newest play
          const dir=(x2>=x1)?1:-1;
          const arr=_svgel("polygon",{ points:x2+","+YMID+" "+(x2-dir*16)+","+(YMID-14)+" "+(x2-dir*16)+","+(YMID+14),
            fill: p.scoringPlay?COL.td:col, stroke:"rgba(0,0,0,0.35)", "stroke-width":1 }); layer.appendChild(arr);
        }
      }
    });

    // markers: current spot = end of last scrimmage play, else drive start
    const los=_svg.querySelector("#fs-los"), ball=_svg.querySelector("#fs-ball"),
          lace=_svg.querySelector("#fs-lace"), first=_svg.querySelector("#fs-first");
    let curTE = scrim.length ? (scrim[scrim.length-1].end||{}).yardsToEndzone
                             : (plays[0] && (plays[0].start||{}).yardsToEndzone);
    const curX=xAt(curTE);
    if(los){ los.setAttribute("x1",curX); los.setAttribute("x2",curX); }
    if(ball){ ball.setAttribute("cx",curX); }
    if(lace){ lace.setAttribute("x1",curX-5); lace.setAttribute("x2",curX+5); }
    const lastStart=(scrim.length?scrim[scrim.length-1].start:(plays[0]||{}).start)||{};
    const dist=lastStart.distance;
    if(first){
      if(dist!=null && curTE!=null){ const fx=Math.min(XG_R, curX+dist/100*SPAN); first.setAttribute("x1",fx); first.setAttribute("x2",fx); first.style.opacity="0.92"; }
      else first.style.opacity="0";
    }
  }

  // ── scoreboard (rendered into the ticker band) ───────────────────────────────
  function lastPlayChip(drive){
    const plays=(drive&&drive.plays)||[];
    const scrim=plays.filter(function(p){ return isScrimmage(playCat((p.type&&p.type.text)||"")); });
    const p=scrim[scrim.length-1]; if(!p) return null;
    const cat=playCat((p.type&&p.type.text)||""), yd=p.statYardage;
    const td=/touchdown/i.test((p.type&&p.type.text)||"") || p.scoringPlay;
    let label, col=COL[cat]||"#fff";
    if(cat==="inc") label="INCOMPLETE";
    else if(cat==="pen") label="PENALTY "+(yd>0?"+"+yd:yd);
    else if(cat==="to") label="TURNOVER";
    else { const nm=cat==="run"?"RUN":cat==="pass"?"PASS":cat==="sack"?"SACK":cat.toUpperCase();
           label=nm+" "+(yd>=0?"+":"")+yd; }
    if(td){ label+="  TD"; col=COL.td; }
    return { label:label, col:col };
  }
  function ddShort(drive){   // "3RD & 7" from the most recent play with a down
    const plays=(drive&&drive.plays)||[];
    for(let i=plays.length-1;i>=0;i--){ const t=((plays[i].start||{}).downDistanceText)||"";
      const m=t.match(/^\s*(\d+\w*\s*&\s*\w+)/i); if(m) return m[1].toUpperCase(); }
    return "";
  }
  /* Compact two-line scoreboard sized to live inside the ticker band (the host positions the
     element in the bottom-left door panel). Line 1 = teams + scores; line 2 = clock · D&D · last play. */
  function renderScore(comp, drive){
    if(!_scoreEl) return;
    const comps=(comp&&comp.competitors)||[];
    const home=comps.find(function(t){return t.homeAway==="home";})||{}, away=comps.find(function(t){return t.homeAway==="away";})||{};
    const type=((comp&&comp.status)||{}).type||{};
    const posId = drive && drive.team ? String(drive.team.id) : null;
    const stCol = type.state==="in"?"#FF6A00":(type.state==="pre"?"#35E0E0":"#d8dce2");
    _scoreEl.replaceChildren();
    const wrap=_el("div","display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5vh;"+
      "width:100%;height:100%;overflow:hidden;font-family:'Oswald',sans-serif;line-height:1;");
    // line 1 — teams + scores, possession football on the team with the ball
    const l1=_el("div","display:flex;align-items:center;justify-content:center;gap:0.9vw;white-space:nowrap;font-weight:700;");
    function side(cp){ const t=cp.team||{}, s=_el("span","display:inline-flex;align-items:center;gap:0.45vw;");
      if(posId && String(t.id)===posId){ const fb=_el("span","font-size:3vh;"); fb.textContent="🏈"; s.appendChild(fb); }
      const ab=_el("span","font-size:4.6vh;letter-spacing:0.02em;color:#fff;"); ab.textContent=(t.abbreviation||t.displayName||"").toUpperCase();
      const sc=_el("span","font-size:4.8vh;font-variant-numeric:tabular-nums;color:#fff;"); sc.textContent=(cp.score==null?"":cp.score);
      s.appendChild(ab); s.appendChild(sc); return s; }
    l1.appendChild(side(away));
    const sep=_el("span","font-size:3vh;color:#6a6f76;"); sep.textContent="–"; l1.appendChild(sep);
    l1.appendChild(side(home));
    wrap.appendChild(l1);
    // line 2 — clock/quarter · down&distance · last-play chip
    const l2=_el("div","display:flex;align-items:center;justify-content:center;gap:0.7vw;white-space:nowrap;"+
      "font-family:'Barlow Condensed',sans-serif;font-weight:700;");
    const clk=_el("span","font-size:3.2vh;color:"+stCol+";letter-spacing:0.02em;"); clk.textContent=type.shortDetail||type.description||""; l2.appendChild(clk);
    const dd=ddShort(drive);
    if(dd){ const s2=_el("span","font-size:2.8vh;color:#555b63;"); s2.textContent="·"; l2.appendChild(s2);
      const d=_el("span","font-size:3vh;color:#FFD400;"); d.textContent=dd; l2.appendChild(d); }
    const chip=lastPlayChip(drive);
    if(chip){ const s3=_el("span","font-size:2.8vh;color:#555b63;"); s3.textContent="·"; l2.appendChild(s3);
      const c=_el("span","font-size:3vh;color:"+chip.col+";"); c.textContent=chip.label; l2.appendChild(c); }
    wrap.appendChild(l2);
    _scoreEl.appendChild(wrap);
  }
  function teamMetaFromHeader(comp){ const m={};
    (((comp||{}).competitors)||[]).forEach(function(c){ const t=c.team||{}; m[String(t.id)]={ abbr:t.abbreviation||"", tc:_tc(t.color) }; });
    return m; }

  // ── paint one frame ──────────────────────────────────────────────────────────
  function clearField(){   // pre-game / between drives: reset markers, no segments
    if(!_svg) return;
    const layer=_svg.querySelector("#fs-plays"); if(layer) layer.replaceChildren();
    const midX=xAt(50), los=_svg.querySelector("#fs-los"), ball=_svg.querySelector("#fs-ball"),
          lace=_svg.querySelector("#fs-lace"), first=_svg.querySelector("#fs-first");
    if(los){ los.setAttribute("x1",midX); los.setAttribute("x2",midX); }
    if(ball){ ball.setAttribute("cx",midX); }
    if(lace){ lace.setAttribute("x1",midX-5); lace.setAttribute("x2",midX+5); }
    if(first){ first.style.opacity="0"; }
    _lastSig="";
  }
  function paint(data, animate){
    const comp=((data.header||{}).competitions||[])[0]||{};
    const dr=data.drives||{};
    const drive=dr.current || (dr.previous&&dr.previous.length? dr.previous[dr.previous.length-1] : null);
    renderScore(comp, drive);
    if(!drive){ clearField(); return; }   // scoreboard-only; never fall back to other games (Colorado-only scene)
    const sig=String(((drive.team||{}).id)||"")+"|"+((drive.plays||[]).length)+"|"+(drive.displayResult||"");
    renderDrive(drive, animate && sig!==_lastSig);
    _lastSig=sig;
  }

  async function tick(){
    if(!_active||_demo) return;
    try{
      const res=await fetch(_sumUrl(_eventId), {cache:"no-store"});
      if(!res.ok) throw new Error("summary HTTP "+res.status);
      const data=await res.json(); if(!_active) return;
      paint(data, true);
    }catch(err){ if(_opts.onError) _opts.onError(err); }
  }

  // ── demo: replay a real completed game's drives/plays over time ───────────────
  async function runDemo(demoId){
    try{
      const res=await fetch(_sumUrl(demoId),{cache:"force-cache"});
      const data=await res.json(); if(!_active) return;
      const comp=((data.header||{}).competitions||[])[0]||{};
      const drives=(data.drives&&data.drives.previous)||[];
      const steps=[];
      drives.forEach(function(d){ const n=(d.plays||[]).length; for(let k=1;k<=n;k++){ steps.push(Object.assign({},d,{plays:d.plays.slice(0,k)})); } });
      if(!steps.length){ if(_opts.onEmpty) _opts.onEmpty(); return; }
      let ix=0;
      (function step(){ if(!_active||!_demo) return;
        paint({ header:{competitions:[comp]}, drives:{ current:steps[ix%steps.length] } }, true);
        ix++; _demoTimer=setTimeout(step, 1600);
      })();
    }catch(err){ if(_opts.onError) _opts.onError(err); }
  }

  // ── public API ────────────────────────────────────────────────────────────────
  function mountFieldSim(container, eventId, opts){
    opts=opts||{}; _opts=opts; stopFieldSim();
    _wrap=container; _scoreEl=opts.scoreEl||null; _active=true; _eventId=eventId;
    _demo=!!opts.demo; _lastSig="";
    buildOverlay(container);
    if(_demo){ runDemo(eventId); return; }
    tick(); _timer=setInterval(tick, 8000);
  }
  function stopFieldSim(){
    _active=false; _demo=false;
    if(_timer){ clearInterval(_timer); _timer=null; }
    if(_demoTimer){ clearTimeout(_demoTimer); _demoTimer=null; }
    _wrap=null; _svg=null; _scoreEl=null; _lastSig="";
  }

  root.mountFieldSim = mountFieldSim;
  root.stopFieldSim  = stopFieldSim;

}(typeof window !== "undefined" ? window : this));

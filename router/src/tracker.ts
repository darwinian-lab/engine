// Injected into every HTML page by the router. Marks the visitor as a real person (js_seen)
// and exposes window.dw.track() for insight-only custom events.
// Custom events never count toward fitness; only router-observed events do.
//
// Running JavaScript is not proof of a human: search-engine renderers, link previewers and SEO
// checkers execute pages too, usually one hit on "/" with no interaction. So js_seen is only sent
// after a human signal: a pointer/touch/key/wheel/scroll interaction on a visible page, and never
// when the browser declares itself automated (navigator.webdriver).
export const TRACKER_JS = `(function(){
  function send(n,p){try{var b=JSON.stringify({n:n,p:p||null,path:location.pathname});
    if(navigator.sendBeacon){navigator.sendBeacon('/_dw/e',new Blob([b],{type:'application/json'}));}
    else{fetch('/_dw/e',{method:'POST',body:b,keepalive:true,headers:{'content-type':'application/json'}});}}catch(e){}}
  window.dw={track:function(n,p){send(n,p);}};
  if(navigator.webdriver)return;
  var t0=Date.now(),done=false,ev=['pointerdown','touchstart','keydown','wheel','scroll','mousemove'];
  function human(e){
    if(done||document.visibilityState==='hidden')return;
    if(e.type==='mousemove'&&!(e.movementX||e.movementY))return;
    done=true;ev.forEach(function(n){removeEventListener(n,human,true);});
    send('js_seen',{via:e.type,ms:Date.now()-t0});
  }
  ev.forEach(function(n){addEventListener(n,human,{capture:true,passive:true});});
})();`;

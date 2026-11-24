// Injected into every HTML page by the router. Marks the visitor as a real browser
// (js_seen) and exposes window.dw.track() for insight-only custom events.
// Custom events never count toward fitness; only router-observed events do.
export const TRACKER_JS = `(function(){
  function send(n,p){try{var b=JSON.stringify({n:n,p:p||null,path:location.pathname});
    if(navigator.sendBeacon){navigator.sendBeacon('/_dw/e',new Blob([b],{type:'application/json'}));}
    else{fetch('/_dw/e',{method:'POST',body:b,keepalive:true,headers:{'content-type':'application/json'}});}}catch(e){}}
  window.dw={track:function(n,p){send(n,p);}};
  send('js_seen');
})();`;

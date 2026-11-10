export class DesktopLayerRecovery {
  constructor({now=Date.now}={}) { this.now=now; this.checked=new Map(); }
  synchronize(native, widget, enabled) {
    if(!enabled || !native.topmost(widget)) {
      this.checked.delete(widget);native.band(widget,enabled);return;
    }
    const foreground=native.foreground(),now=this.now(),previous=this.checked.get(widget);
    if(previous?.foreground===foreground && now>=previous.at && now-previous.at<1000)return;
    this.checked.set(widget,{foreground,at:now});
    if(!foreground||foreground===widget||!native.visible(foreground)||native.topmost(foreground)||native.pid(foreground)===native.pid(widget))return;
    const a=native.rect(widget),b=native.rect(foreground);
    if(!a||!b||a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top)return;
    let h=native.previous(widget);
    for(let n=0;h&&n<2048;n++,h=native.previous(h))if(h===foreground){native.reassertTopmost(widget);return;}
  }
  close() { this.checked.clear(); }
}

// This is called only by the explicit completion-bubble click route.
export function activateCodexWindow(native, preferred=0) {
  const target=native.isCodex(preferred)?preferred:native.findCodex()||native.hosts('codex')[0]?.handle;
  if(!target||!native.isCodex(target))return false;
  if(native.minimized(target))native.restoreWindow(target);
  return native.foregroundWindow(target);
}

// Generic host activation is still explicit-click only. Merely discovering or
// following a DSH/Codex window never restores, raises, or steals foreground.
export function activateHostWindow(native, preferred=0, source='dsh') {
  if(source!=='dsh'&&source!=='codex')return false;
  const target=native.isHost(preferred,source)?preferred:native.findHost(source)||native.hosts(source)[0]?.handle;
  if(!target||!native.isHost(target,source))return false;
  if(native.minimized(target))native.restoreWindow(target,source);
  return native.foregroundWindow(target,source);
}

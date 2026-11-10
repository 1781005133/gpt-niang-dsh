import test from 'node:test';
import assert from 'node:assert/strict';

test('isolated hidden Win32 window retains 84 scaled GDI regions and fresh Input DLL no-activation behavior', {skip:process.platform!=='win32'}, async t=>{
  // Create only a hidden HWND owned by this test's process/thread. No Electron
  // application, companion, profile, installer, task, or DSH window is started.
  const {default:koffi}=await import('koffi');
  const {NativeWindows}=await import('../src/windows/native.mjs');
  const {encodeRegion}=await import('../src/windows/shape.mjs');
  const user=koffi.load('user32.dll'),gdi=koffi.load('gdi32.dll'),kernel=koffi.load('kernel32.dll');
  const Transform=koffi.struct('DshCompanionTestTransform',{a:'float',b:'float',c:'float',d:'float',x:'float',y:'float'});
  const createWindow=user.func('intptr_t __stdcall CreateWindowExW(uint32_t ex,const uint16_t *cls,const uint16_t *title,uint32_t style,int x,int y,int width,int height,intptr_t parent,intptr_t menu,intptr_t instance,intptr_t param)'),
    destroy=user.func('bool __stdcall DestroyWindow(intptr_t window)'),
    send=user.func('intptr_t __stdcall SendMessageW(intptr_t h,uint32_t message,intptr_t w,intptr_t l)'),
    create=gdi.func('intptr_t __stdcall CreateRectRgn(int left,int top,int right,int bottom)'),
    extended=gdi.func('intptr_t __stdcall ExtCreateRegion(DshCompanionTestTransform *matrix,uint32_t count,void *data)'),
    get=user.func('int __stdcall GetWindowRgn(intptr_t window,intptr_t region)'),
    equal=gdi.func('bool __stdcall EqualRgn(intptr_t first,intptr_t second)'),
    combine=gdi.func('int __stdcall CombineRgn(intptr_t result,intptr_t first,intptr_t second,int mode)'),
    remove=gdi.func('bool __stdcall DeleteObject(intptr_t object)'),
    current=kernel.func('intptr_t __stdcall GetCurrentProcess()'),
    resources=user.func('uint32_t __stdcall GetGuiResources(intptr_t process,uint32_t flags)');
  const wide=text=>Buffer.from(text+'\0','utf16le');
  const h=Number(createWindow(0,wide('STATIC'),wide('DSHGPTCompanion isolated hidden test'),0x80000000,10,10,320,320,0,0,0,0));
  assert.ok(h,'hidden test HWND creation');
  const native=new NativeWindows(),result={};
  try {
    native.noActivate(h);
    assert.equal(Number(send(h,0x21,0,0)),3,'WM_MOUSEACTIVATE must return MA_NOACTIVATE');
    result.dpi=native.dpi(h);assert.ok(result.dpi>0);
    result.noActivate=true;
    const r=native.rect(h),size={width:r.right-r.left,height:r.bottom-r.top};
    assert.equal(native.move(h,{x:r.left+.1,y:r.top-.1,width:size.width+.1,height:size.height-.1}),false);
    assert.equal(native.move(h,{x:r.left+2.1,y:r.top+3.1,...size}),true);
    assert.equal(native.rect(h).left,r.left+2);assert.equal(native.rect(h).top,r.top+3);
    const resource={width:40,height:50,rects:[[2,3,12,10],[2,10,35,30],[15,30,29,46]]},bytes=encodeRegion(resource);
    const matrices=[[1,0,0,1,10.01,14.01],[1,0,0,1,10.02,14.02]];
    for(const mirror of [-1,1])for(const dpi of [.75,1,1.25,1.5,2])for(const squash of [.6,.88,1,1.16])
      matrices.push([mirror*dpi,0,0,dpi*squash,mirror<0?120.25:10.25,14.4]);
    let compared=0;
    const frame=native.rect(h);
    for(const clip of [null,{left:frame.left+5,top:frame.top+6,right:frame.left+90,bottom:frame.top+70}]){
      native.clip(h,clip);
      for(const m of matrices){
        assert.equal(native.updateShape(h,{resources:compared===0?{girl:resource}:null,matrices:{girl:m}}),true);
        const expected=extended({a:m[0],b:m[1],c:m[2],d:m[3],x:m[4],y:m[5]},bytes.length,bytes),actual=create(0,0,0,0);
        assert.ok(expected&&actual);
        try {
          if(clip){const p=native.rect(h),c=create(Math.max(0,clip.left-p.left),Math.max(0,clip.top-p.top),Math.min(size.width,clip.right-p.left),Math.min(size.height,clip.bottom-p.top));
            try{assert.notEqual(combine(expected,expected,c,1),0);}finally{remove(c);}}
          assert.notEqual(get(h,actual),0);assert.equal(equal(actual,expected),true);compared++;
        } finally {remove(expected);remove(actual);}
      }
    }
    result.compared=compared;result.shape=native.shapeStatus(h);
    assert.equal(compared,84);assert.ok(result.shape.equivalentUpdates>0);
    const before=resources(current(),0);
    for(let n=0;n<1000;n++)native.updateShape(h,{matrices:{girl:[1,0,0,1,10+(n%2)*.01,14+(n%2)*.01]}});
    const after=resources(current(),0);assert.ok(after<=before+2);
    result.gdiObjects={before,after};
    t.diagnostic(JSON.stringify(result));
  } finally {
    native.close();assert.equal(destroy(h),true);
  }
});

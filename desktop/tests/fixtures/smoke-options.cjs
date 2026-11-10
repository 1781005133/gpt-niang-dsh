const path=require('node:path');
exports.resolveSmokeProfile=({env=process.env,argv=process.argv}={})=>{
  const named=argv.find(value=>value.startsWith('--companion-smoke-profile='));
  const value=env.COMPANION_SMOKE_PROFILE??named?.slice('--companion-smoke-profile='.length);
  if(typeof value!=='string'||!path.isAbsolute(value)||value.startsWith('--'))throw Error('Missing explicit absolute smoke profile');
  return path.resolve(value);
};

import { chromium } from 'playwright';
const S='/private/tmp/claude-501/-Users-linchen-Downloads-ai/39567008-0b04-4a57-918a-9eae8a74237a/scratchpad';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto('http://127.0.0.1:8185',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(6000);
const title = p.getByText('信任这个项目文件夹', {exact:false});
console.log('刷新后弹窗还在?', await title.count(), '（上一跑已点过「阻止项目配置」）');
if (await title.count()) {
  console.log('→ 复现：已阻止的目录重新加载仍然再问一遍');
  await p.screenshot({path:`${S}/trust-reask.png`});
  const blockBtn = p.getByRole('button',{name:'阻止项目配置'});
  console.log('阻止按钮数=', await blockBtn.count());
  await blockBtn.last().click();
  await p.waitForTimeout(3000);
  console.log('再点阻止后弹窗还在?', await title.count(), '← >0 即「点了删不掉」');
  await p.screenshot({path:`${S}/trust-after-block2.png`});
}
await b.close();

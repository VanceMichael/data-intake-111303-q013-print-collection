const app = document.querySelector('#app');
let state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML = '<div class="screen-only"><p data-summary="true">摘要旧值：不能当完整资料</p><input id="registration" value="reg-1"><button id="generate">生成打印件</button></div><section id="preview" data-state="empty"></section>' + feedback;
function preview(revision) {
 const panel=document.querySelector('#preview');panel.dataset.registration='reg-1';panel.dataset.revision=String(revision);panel.dataset.state='ready';panel.classList.add('page-ready');
 panel.innerHTML='<article class="print-page" data-page="1"><h2>登记 reg-1 修订 '+revision+'</h2><table><thead><tr><th>编号</th><th>内容</th></tr></thead><tbody><tr data-line="l1"><td>l1</td><td>湖站水样</td></tr><tr data-line="l2" data-continued="true"><td>l2</td><td>岩芯上段</td></tr></tbody></table><footer>第1页</footer></article><article class="print-page" data-page="2"><table><thead><tr><th>编号</th><th>内容</th></tr></thead><tbody><tr data-line="l2" data-continuation="true"><td>l2续</td><td>附深层说明</td></tr></tbody></table><span class="watermark">档案副本</span><footer>第2页</footer></article>';
}
document.querySelector('#generate').onclick=async()=>{
 const result=await action({action:'generate',registration:document.querySelector('#registration').value});
 if(result.value.failed){document.querySelector('#preview').dataset.state='failed';return;}
 if(result.value.staleFirst)preview(1);
 setTimeout(()=>preview(2),80);
};

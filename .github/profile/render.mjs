import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const templates=path.join(root,'.github/profile/templates');
const owner='Trovoy';
const featured=['Weibo_Checkin','f1-radio-translator'];
const keys=['weibo','f1'];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const arg=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1]};
const day=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
async function api(route){
  const response=await fetch(`https://api.github.com${route}`,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(process.env.GH_TOKEN?{Authorization:`Bearer ${process.env.GH_TOKEN}`}:{})},signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`GitHub returned ${response.status} for ${route}`);
  return response.json();
}
async function collect(){
  const all=await Promise.all(featured.map(async name=>{
    const [repo,commits]=await Promise.all([api(`/repos/${owner}/${name}`),api(`/repos/${owner}/${name}/commits?per_page=4`)]);
    // Explicitly reject private sources, including if a repository changes visibility.
    if(repo.private!==false||repo.owner.login.toLowerCase()!==owner.toLowerCase())throw new Error('The source must be an owned public repository.');
    return {repo,commits:commits.map(c=>({repo:name,sha:c.sha,url:c.html_url,date:c.commit.author.date,message:c.commit.message.split('\n')[0]}))};
  }));
  return {repos:all.map(x=>x.repo),commits:all.flatMap(x=>x.commits)};
}
const input=arg('--snapshot');
const data=input?JSON.parse(await fs.readFile(path.resolve(input),'utf8')):await collect();
for(const repo of data.repos)if(repo.private!==false||!featured.includes(repo.name))throw new Error('Unexpected repository in snapshot.');
const recent=data.commits.filter(c=>featured.includes(c.repo)&&/^https:\/\/github\.com\/Trovoy\//.test(c.url)).sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,3);
if(recent.length!==3)throw new Error('Three public commits are required to render the activity log.');
const output=path.join(root,'assets');
await fs.mkdir(output,{recursive:true});
const written=[];
async function emit(name,content){
  // A new asset path also invalidates GitHub's cached opaque SVGs.
  const target=name.endsWith('.svg')?name.replace('.svg','-transparent.svg'):name;
  await fs.writeFile(path.join(output,target),content);written.push(`assets/${target}`);
}
async function template(name){return fs.readFile(path.join(templates,name),'utf8')}
function wrapText(str,maxWidth,size){
  const lines=[];let line='',width=0;
  for(const c of str){const cw=/[\u2e80-\uffff]/u.test(c)?size:size*.57;if(width+cw>maxWidth&&line){lines.push(line);line='';width=0;}line+=c;width+=cw;}
  if(line)lines.push(line);
  return lines;
}
for(const theme of ['dark','light']){
  for(let i=0;i<featured.length;i++){
    const repo=data.repos.find(r=>r.name===featured[i]);
    if(!repo)throw new Error('Missing project metadata.');
    const last=data.commits.filter(c=>c.repo===repo.name).sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
    for(const mobile of [false,true]){
      const name=`${keys[i]}${mobile?'-mobile':''}-${theme}.svg`;
      const svg=(await template(name)).replaceAll('{{STARS}}',String(repo.stargazers_count)).replaceAll('{{UPDATED}}',day(last.date)).replaceAll('{{STATUS_COLOR}}',new Date()-new Date(last.date)<30*86400000?'#548367':'#a99b85');
      await emit(name,svg);
    }
  }
  for(const mobile of [false,true]){
    const rows=recent.map((c,i)=>{
      const x=mobile?79:92,y=(mobile?99:95)+i*(mobile?112:78),size=mobile?23:22,max=mobile?438:800;
      const titleLines=wrapText(c.message,max,size).slice(0,2);
      if(wrapText(c.message,max,size).length>2)titleLines[1]=titleLines[1].slice(0,-2)+'…';
      const date=day(c.date);
      return `<g><circle cx="${mobile?55:66}" cy="${y-6}" r="4" fill="#b96f51"${i===0?' class="ink-pulse"':''}/><text x="${x}" y="${y}" font-family="'Courier New',monospace" font-size="${mobile?15:16}" fill="#8b7b66">${escape(c.repo)} / ${escape(c.sha.slice(0,7))}</text><text x="${mobile?510:893}" y="${y-22}" text-anchor="end" font-family="'Courier New',monospace" font-size="${mobile?14:15}" fill="#8b7b66">${date}</text>${titleLines.map((line,j)=>`<text x="${x}" y="${y+30+j*(mobile?27:26)}" font-family="Georgia,'Noto Serif SC',SimSun,serif" font-size="${size}" fill="#302920">${escape(line)}</text>`).join('')}</g>`;
    }).join('');
    const name=`activity${mobile?'-mobile':''}-${theme}.svg`;
    await emit(name,(await template(name)).replace('{{ROWS}}',rows));
  }
  const raw=await fs.readFile(path.resolve(arg('--snake')||path.join(root,'dist/raw-snake.svg')),'utf8');
  const tag=raw.match(/<svg\b([^>]*)>/);
  if(!tag)throw new Error('Snake output is not an SVG.');
  const view=tag[1].match(/viewBox="([^"]+)"/)?.[1]||'0 0 880 192';
  // Resolve the snake's CSS variables so nested SVGs keep the paper palette.
  const palette={cb:'#b9ab9426',cs:'#a2523e',ce:'#e9e2d4',c0:'#e9e2d4',c1:'#edc7b3',c2:'#dba080',c3:'#b97558',c4:'#8b523d'};
  const body=raw.slice(tag.index+tag[0].length).replace(/<\/svg>\s*$/,'').replace(/var\(--(cb|cs|ce|c[0-4])\)/g,(_,key)=>palette[key]);
  const snake=`<svg x="40" y="65" width="880" height="192" viewBox="${escape(view)}">${body}</svg>`;
  await emit(`contribution-trail-${theme}.svg`,(await template(`contributions-${theme}.svg`)).replace('{{SNAKE}}',snake));
}

function picture(key,alt,mobile=false){
  return `<picture>\n${mobile?`  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="./assets/${key}-mobile-dark-transparent.svg">\n  <source media="(max-width: 600px)" srcset="./assets/${key}-mobile-light-transparent.svg">\n`:''}  <source media="(prefers-color-scheme: dark)" srcset="./assets/${key}-dark-transparent.svg">\n  <source media="(prefers-color-scheme: light)" srcset="./assets/${key}-light-transparent.svg">\n  <img alt="${escape(alt)}" src="./assets/${key}-dark.svg" width="100%">\n</picture>`;
}
const readme=`${picture('collage-header','Troy — I make small things. 猫猫、撕纸与黑胶的拼贴头图。')}\n\n<p align="center">\n  <a href="https://github.com/Trovoy?tab=repositories"><code>REPOSITORIES</code></a> &nbsp; / &nbsp;\n  <a href="https://github.com/Trovoy?tab=overview"><code>ACTIVITY</code></a> &nbsp; / &nbsp;\n  <a href="https://lisalove.me"><code>BLOG</code></a>\n</p>\n\n<a href="https://github.com/Trovoy/Weibo_Checkin">\n${picture('weibo','Weibo Check-in：扫码登录、超话等级读取与定时签到。TypeScript、Cloudflare Workers、Durable Objects。点击查看项目。',true)}\n</a>\n\n<a href="https://github.com/Trovoy/f1-radio-translator">\n${picture('f1','F1 Radio Translator：本地 OCR 识别 MultiViewer 无线电转录，提供英中双语翻译。PowerShell、C#、Python、WPF。点击查看项目。',true)}\n</a>\n\n<a href="https://github.com/Trovoy?tab=overview">\n${picture('activity','近期公开提交：'+recent.map(c=>`${c.repo} · ${c.message} · ${day(c.date)}`).join('；'),true)}\n</a>\n\n${picture('contribution-trail','GitHub 贡献贪吃蛇：真实贡献记录，纸质边框，每日更新。')}\n\n<p align="center"><sub>小工具，慢慢做。 / Building small tools.</sub></p>\n`;
await fs.writeFile(path.join(root,'README.md'),readme);written.push('README.md');
await emit('profile-data.json',JSON.stringify({updatedAt:new Date().toISOString(),source:'Public GitHub REST API',projects:data.repos.map(r=>({name:r.name,url:r.html_url,stars:r.stargazers_count,language:r.language})),commits:recent},null,2)+'\n');
await fs.writeFile(path.join(root,'.github/profile/generated-files.json'),JSON.stringify(written,null,2));
console.log(`Rendered ${written.length} files from owned public GitHub repositories.`);

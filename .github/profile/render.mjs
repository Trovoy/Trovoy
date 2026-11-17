import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const templates=path.join(root,'.github/profile/templates');
const owner='Trovoy';
const featured=['Weibo_Checkin','f1-radio-translator','afterglow'];
const keys=['weibo','f1','afterglow'];
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
  return {repos:all.map(x=>x.repo),commits:all.flatMap(x=>x.commits),...await collectExtras()};
}
async function graphql(query,variables){
  const response=await fetch('https://api.github.com/graphql',{method:'POST',headers:{'Content-Type':'application/json',...(process.env.GH_TOKEN?{Authorization:`Bearer ${process.env.GH_TOKEN}`}:{})},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(25000)});
  const body=await response.json();
  if(!response.ok||body.errors)throw new Error(`GitHub GraphQL failed: ${response.status}`);
  return body.data;
}
// "Now building" and "year in numbers": public, owned, non-fork repositories only.
async function collectExtras(){
  const repos=(await api(`/users/${owner}/repos?type=owner&sort=pushed&per_page=100`)).filter(r=>r.private===false&&!r.fork&&r.owner.login.toLowerCase()===owner.toLowerCase());
  const active=repos.filter(r=>!r.archived&&r.name.toLowerCase()!==owner.toLowerCase()).sort((a,b)=>new Date(b.pushed_at)-new Date(a.pushed_at))[0];
  const since=new Date(Date.now()-7*86400000).toISOString();
  const [[last],week,cal]=await Promise.all([
    api(`/repos/${owner}/${active.name}/commits?per_page=1`),
    api(`/repos/${owner}/${active.name}/commits?per_page=100&since=${since}`),
    graphql('query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}',{login:owner})]);
  const calendar=cal.user.contributionsCollection.contributionCalendar;
  const days=calendar.weeks.flatMap(w=>w.contributionDays);
  let longest=0,run=0;for(const d of days){run=d.contributionCount>0?run+1:0;longest=Math.max(longest,run)}
  return {
    now:{repo:active.name,url:active.html_url,sha:last.sha,date:last.commit.author.date,message:last.commit.message.split('\n')[0],week:week.length},
    year:{contributions:calendar.totalContributions,active:days.filter(d=>d.contributionCount>0).length,longest,stars:repos.reduce((n,r)=>n+r.stargazers_count,0)}
  };
}
const input=arg('--snapshot');
const data=input?JSON.parse(await fs.readFile(path.resolve(input),'utf8')):await collect();
if(!data.now||!data.year)throw new Error('Missing now-building or year-in-numbers data.');
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
    for(const language of ['en','zh-CN'])for(const mobile of [false,true]){
      const name=`${keys[i]}${language==='en'?'-en':''}${mobile?'-mobile':''}-${theme}.svg`;
      const svg=(await template(name)).replaceAll('{{STARS}}',String(repo.stargazers_count)).replaceAll('{{UPDATED}}',day(last.date)).replaceAll('{{STATUS_COLOR}}',new Date()-new Date(last.date)<30*86400000?'#548367':'#a99b85');
      await emit(name,svg);
    }
  }
  for(const mobile of [false,true]){
    const rows=recent.map((c,i)=>{
      const x=mobile?79:92,y=(mobile?99:95)+i*(mobile?112:78),size=mobile?23:22,max=mobile?438:800;
      // Desktop rows are 78px apart and only fit one line; mobile rows fit two.
      const maxLines=mobile?2:1,allLines=wrapText(c.message,max,size),titleLines=allLines.slice(0,maxLines);
      if(allLines.length>maxLines)titleLines[maxLines-1]=titleLines[maxLines-1].slice(0,-2)+'…';
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

// ---- "Now building": the repository name is typed out, then the latest commit fades in. ----
const nowMeta=data.now.week>0?`${data.now.week} commit${data.now.week===1?'':'s'} this week`:'quiet week';
for(const theme of ['dark','light'])for(const mobile of [false,true]){
  const size=mobile?26:30,cw=size*.6,x0=mobile?56:75,base=84,start=.5,per=.09,name=[...data.now.repo];
  const typed=name.map((c,i)=>`<text class="key" x="${(x0+(i+1.4)*cw).toFixed(1)}" y="${base}" style="animation-delay:${(start+i*per).toFixed(2)}s">${escape(c)}</text>`).join('');
  const done=start+name.length*per,caretX=x0+(name.length+1.55)*cw;
  const caret=`<rect class="caret" x="${caretX.toFixed(1)}" y="${base-size*.78}" width="3" height="${size*.92}" fill="#b66d50"/>`;
  const msgSize=mobile?18:19,lines=wrapText(data.now.message,mobile?440:800,msgSize),max=mobile?2:1,shown=lines.slice(0,max);
  if(lines.length>max)shown[max-1]=shown[max-1].slice(0,-2)+'…';
  const msgY=mobile?[140,168]:[112],metaX=mobile?56:885,metaY=mobile?112:base,anchor=mobile?'start':'end';
  const body=`<style>@keyframes key{from{opacity:0}}@keyframes caret-move{from{transform:translateX(${(-name.length*cw).toFixed(1)}px)}}@keyframes blink{50%{opacity:0}}@keyframes rise{from{opacity:0;transform:translateY(4px)}}`+
    `.key{font-family:'Courier New',Courier,monospace;font-size:${size}px;fill:#2a241c;animation:key .01s step-end both}`+
    `.caret{animation:caret-move ${(done-start).toFixed(2)}s steps(${name.length},end) ${start}s both,blink 1.05s step-end ${(done+.1).toFixed(2)}s infinite}`+
    `.late{animation:rise .6s ease-out ${(done+.25).toFixed(2)}s both}`+
    `@media(prefers-reduced-motion:reduce){.key,.caret,.late{animation:none}}</style>`+
    `<text x="${x0}" y="${base}" font-family="'Courier New',Courier,monospace" font-size="${size}" fill="#b66d50">&gt;</text>${typed}${caret}`+
    `<g class="late"><text x="${metaX}" y="${metaY}" text-anchor="${anchor}" font-family="'Courier New',monospace" font-size="${mobile?13:14}" fill="#8b7b66">${escape(day(data.now.date))} · ${escape(data.now.sha.slice(0,7))} · ${escape(nowMeta)}</text>`+
    shown.map((l,i)=>`<text x="${x0}" y="${msgY[i]}" font-family="Georgia,'Noto Serif SC',SimSun,serif" font-size="${msgSize}" fill="#51483c">${escape(l)}</text>`).join('')+`</g>`;
  const name2=`now${mobile?'-mobile':''}-${theme}.svg`;
  await emit(name2,(await template(name2)).replace('{{BODY}}',body));
}

// ---- Year in numbers: rubber stamps land one by one, then each figure rolls up like an odometer. ----
for(const theme of ['dark','light'])for(const mobile of [false,true]){
  const name=`numbers${mobile?'-mobile':''}-${theme}.svg`;
  let svg=await template(name);
  const widths=svg.match(/<!--digits:[\d.]+:([\d.,]+)-->/)[1].split(',').map(Number);
  const colW=27,lineH=54,css=[];
  [data.year.contributions,data.year.active,data.year.longest,data.year.stars].forEach((value,i)=>{
    const digits=[...String(value)],left=-digits.length*colW/2,stampDelay=.25+i*.28;
    const cols=digits.map((d,k)=>{
      const id=`o${i}${k}`,target=(10+Number(d))*lineH,rows=Array.from({length:20},(_,j)=>`<use href="#dg${j%10}" x="${((colW-widths[j%10])/2).toFixed(2)}" y="${j*lineH}"/>`).join('');
      css.push(`#${id}{transform:translateY(-${target}px);animation:roll .9s cubic-bezier(.15,.75,.25,1) ${(stampDelay+.45+(digits.length-1-k)*.12).toFixed(2)}s both}`);
      return `<clipPath id="c${id}"><rect x="-2" y="-40" width="${colW+4}" height="52"/></clipPath><g transform="translate(${(left+k*colW).toFixed(1)} 0)" clip-path="url(#c${id})"><g class="odo" id="${id}">${rows}</g></g>`;
    }).join('');
    svg=svg.replace(`{{N${i+1}}}`,cols);
  });
  svg=svg.replace('{{ODO_CSS}}','@keyframes roll{from{transform:translateY(0)}}'+css.join(''));
  await emit(name,svg);
}

function picture(key,alt,mobile=false){
  const src=(theme,small=false)=>'./assets/'+key+(small?'-mobile':'')+'-'+theme+'-transparent.svg';
  return '<picture>\n'+(mobile?'  <source media="(max-width: 600px) and (prefers-color-scheme: dark)" srcset="'+src('dark',true)+'">\n  <source media="(max-width: 600px)" srcset="'+src('light',true)+'">\n':'')+'  <source media="(prefers-color-scheme: dark)" srcset="'+src('dark')+'">\n  <source media="(prefers-color-scheme: light)" srcset="'+src('light')+'">\n  <img alt="'+escape(alt)+'" src="'+src('light')+'" width="100%">\n</picture>';
}
for(const language of ['en','zh-CN']){
  const en=language==='en';
  const nav=en?'**English** | [简体中文](README.zh-CN.md)':'[English](README.md) | **简体中文**';
  const weibo=en?'Self-hosted Weibo and NodeSeek check-ins on Cloudflare Workers. Open the repository.':'微博与 NodeSeek 自托管签到工作台。点击查看项目。';
  const f1=en?'F1 Radio Translator: live Chinese subtitles for F1 team radio, laid over the race. Open the repository.':'F1 Radio Translator：F1 车队无线电实时中文字幕，叠在比赛画面上。点击查看项目。';
  const afterglow=en?'Afterglow: bring concert LED wristbands back to life at home with an ESP32 and a CC1101. Open the repository.':'Afterglow 余场：让演唱会带回来的荧光手环在家重新亮起来。点击查看项目。';
  const now=(en?`Now building: ${data.now.repo} — ${data.now.message} (${day(data.now.date)}, ${nowMeta}).`:`正在做：${data.now.repo}——${data.now.message}（${day(data.now.date)}）。`);
  const y=data.year,numbers=en?`Last 12 months: ${y.contributions} contributions, ${y.active} active days, longest streak ${y.longest} days, ${y.stars} stars earned.`:`近 12 个月：${y.contributions} 次贡献，${y.active} 天有提交，最长连续 ${y.longest} 天，共获得 ${y.stars} 颗星。`;
  const activity=(en?'Recent public commits: ':'近期公开提交：')+recent.map(c=>c.repo+' · '+c.message+' · '+day(c.date)).join('; ');
  const blocks=[nav,picture('collage-header','Troy — I make small things.'),'<p align="center">\n  <a href="https://github.com/Trovoy?tab=repositories"><code>REPOSITORIES</code></a> &nbsp; / &nbsp;\n  <a href="https://github.com/Trovoy?tab=overview"><code>ACTIVITY</code></a> &nbsp; / &nbsp;\n  <a href="https://lisalove.me"><code>BLOG</code></a>\n</p>',
    '<a href="'+escape(data.now.url)+'">\n'+picture('now',now,true)+'\n</a>',
    '<a href="https://github.com/Trovoy/Weibo_Checkin">\n'+picture('weibo'+(en?'-en':''),weibo,true)+'\n</a>',
    '<a href="https://github.com/Trovoy/f1-radio-translator">\n'+picture('f1'+(en?'-en':''),f1,true)+'\n</a>',
    '<a href="https://github.com/Trovoy/afterglow">\n'+picture('afterglow'+(en?'-en':''),afterglow,true)+'\n</a>',
    '<a href="https://github.com/Trovoy?tab=overview">\n'+picture('activity',activity,true)+'\n</a>',
    picture('contribution-trail',en?'GitHub contribution snake, refreshed daily.':'GitHub 贡献贪吃蛇，每日更新。'),
    picture('numbers',numbers,true),
    '<p align="center"><sub>'+(en?'Building small tools.':'小工具，慢慢做。')+'</sub></p>'];
  const name=en?'README.md':'README.zh-CN.md';
  await fs.writeFile(path.join(root,name),blocks.join('\n\n')+'\n');written.push(name);
}
const snapshot={source:'Public GitHub REST and GraphQL APIs',projects:data.repos.map(r=>({name:r.name,url:r.html_url,stars:r.stargazers_count,language:r.language})),commits:recent,now:data.now,year:data.year};
// Keep the previous timestamp when nothing else changed, so a quiet day does not commit a new timestamp alone.
const previous=await fs.readFile(path.join(output,'profile-data.json'),'utf8').then(JSON.parse).catch(()=>null);
const {updatedAt:previousAt,...previousRest}=previous||{};
const updatedAt=previousAt&&JSON.stringify(previousRest)===JSON.stringify(snapshot)?previousAt:new Date().toISOString();
await emit('profile-data.json',JSON.stringify({updatedAt,...snapshot},null,2)+'\n');
await fs.writeFile(path.join(root,'.github/profile/generated-files.json'),JSON.stringify(written,null,2));
console.log(`Rendered ${written.length} files from owned public GitHub repositories.`);

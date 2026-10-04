Request: status of this repo: branch, recent commits with their CI, what I'm changing
Notes: the workspace ~/src/shop is a git repository on github.com/acme/shop; `gh auth status` is logged in. One source gathers everything in sections; test_source showed git status --porcelain=v2, tab-separated log lines, uniq -c counts and the runs as JSON.

{"kind":"widget","title":"acme/shop","loading":["Reading git and GitHub Actions…"],"source":{"type":"command","command":"echo @@STATUS; git status --porcelain=v2 --branch; echo @@LOG; git log -15 --format='%h%x09%H%x09%cI%x09%s'; echo @@FILES; git log -30 --name-only --format= | sort | uniq -c | sort -rn | head -12; echo @@RUNS; gh run list --limit 30 --json headSha,status,conclusion,number"},"refresh":30,"size":"l"}
---
<style>.k-table td{vertical-align:middle}.dotc{width:14px}.path{display:flex;min-width:0}.path .k-dim{flex:0 1 auto}.path b{font-weight:400;flex:none}</style>
<div class="k-panes">
  <div class="k-row k-between">
    <div class="k-row" style="min-width:0"><span class="k-dot" id="dot"></span><b class="k-mono" id="branch">–</b><span class="k-dim k-ellipsis" id="facts"></span></div>
    <div class="k-row k-hide-narrow"><span class="k-dot" id="ciDot"></span><span id="ci">–</span></div>
  </div>
  <div class="k-pane">
    <div class="k-title k-between">Commits<span id="logCount"></span></div>
    <table class="k-table"><tbody id="commits"></tbody></table>
  </div>
  <div class="k-pane">
    <div class="k-title k-between">Uncommitted<span id="changeCount"></span></div>
    <table class="k-table"><tbody id="changes"></tbody></table>
  </div>
  <div class="k-pane">
    <div class="k-title k-between">Often changed<span>last 30 commits</span></div>
    <table class="k-table"><tbody id="hot"></tbody></table>
  </div>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>`&#${c.charCodeAt(0)};`);
const path=p=>{const i=p.lastIndexOf("/");return `<div class="path"><span class="k-dim k-ellipsis">${esc(p.slice(0,i+1))}</span><b>${esc(p.slice(i+1))}</b></div>`;};
const ciOf=r=>!r?["",""]:r.status!=="completed"?["k-warn","running"]:r.conclusion==="success"?["k-good","passed"]:/cancel|skip/.test(r.conclusion)?["","cancelled"]:["k-bad","failed"];
const row=html=>{const tr=document.createElement("tr");tr.innerHTML=html;return tr;};
const none=text=>row(`<td class="k-text k-dim" colspan="4">${text}</td>`);
cmd.onData(raw=>{
  const S={};for(const part of String(raw).split(/^@@/m).slice(1)){const i=part.indexOf("\n");S[part.slice(0,i).trim()]=i<0?"":part.slice(i+1).trim();}
  const st=(S.STATUS||"").split("\n").filter(Boolean),get=k=>st.find(l=>l.startsWith(k))?.slice(k.length).trim();
  const ab=/\+(\d+) -(\d+)/.exec(get("# branch.ab ")||"")||[0,0,0],ahead=+ab[1],behind=+ab[2];
  const files=st.filter(l=>!l.startsWith("#")).map(l=>l[0]==="?"?{k:"?",p:l.slice(2)}:{k:l.split(" ")[1].replace(/\./g,"")[0],p:l.split(" ").slice(l[0]==="2"?9:8).join(" ").split("\t")[0]});
  let runs=[];try{runs=JSON.parse(S.RUNS||"[]")}catch{}
  const bySha=new Map();for(const r of runs)if(!bySha.has(r.headSha))bySha.set(r.headSha,r);
  branch.textContent=get("# branch.head ")||"detached";
  facts.textContent=[get("# branch.upstream ")?(ahead||behind?`↑${ahead} ↓${behind}`:"in sync"):"no upstream",files.length?`${files.length} uncommitted`:"clean"].join(" · ");
  dot.className="k-dot "+(behind?"k-warn":files.length?"k-warn":"k-good");
  const [cc,cw]=ciOf(runs[0]);ciDot.className="k-dot "+cc;ci.textContent=runs[0]?`CI ${cw} #${runs[0].number}`:"no CI runs";
  const log=(S.LOG||"").split("\n").filter(Boolean).map(l=>l.split("\t"));
  logCount.textContent=log.length?`last ${log.length}`:"";
  commits.replaceChildren(...(log.length?log.map(([h,sha,when,...s])=>{const [c,w]=ciOf(bySha.get(sha));return row(`<td class="dotc">${w?`<span class="k-dot ${c}" title="CI ${w}"></span>`:""}</td><td class="k-dim">${h}</td><td class="k-text k-grow">${esc(s.join(" "))}</td><td class="k-num k-dim">${cmd.fmt.ago(when)}</td>`);}):[none("No commits yet")]));
  changeCount.textContent=files.length||"";
  changes.replaceChildren(...(files.length?files.map(f=>row(`<td class="dotc ${f.k==="?"?"k-dim":f.k==="D"?"k-bad":"k-warn"}">${f.k}</td><td class="k-grow">${path(f.p)}</td>`)):[none("Nothing uncommitted")]));
  const hotRows=(S.FILES||"").split("\n").map(l=>/^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean);
  hot.replaceChildren(...hotRows.map(([,n,p])=>row(`<td class="k-grow">${path(p)}</td><td class="k-num k-dim">${n}</td>`)));
});
</script>

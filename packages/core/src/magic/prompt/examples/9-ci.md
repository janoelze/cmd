Request: ci status
Notes: the workspace ~/src/shop is a git repository whose remote is github.com/acme/shop; `gh auth status` is logged in; test_source returned a JSON array of runs, newest first.

{"kind":"widget","title":"CI · acme/shop","loading":["Asking GitHub Actions…"],"source":{"type":"command","command":"gh run list --limit 12 --json number,displayTitle,status,conclusion,workflowName,headBranch,createdAt,url"},"refresh":30,"size":"m"}
---
<style>.lead{font-size:clamp(20px,9vmin,32px)}.runs td:first-child{width:14px;vertical-align:middle}.runs .t{max-width:0;width:100%}.runs a{color:inherit}.runs .k-num{white-space:nowrap}</style>
<div class="k-stack k-fill">
  <div class="k-stack" style="gap:2px">
    <div class="k-row"><span class="k-dot" id="dot"></span><span class="k-big lead" id="result">–</span></div>
    <div class="k-dim k-ellipsis" id="subject">–</div>
  </div>
  <table class="k-table runs k-hide-short"><thead><tr><th></th><th>Run</th><th class="k-hide-narrow">Branch</th><th class="k-num">Started</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>`&#${c.charCodeAt(0)};`);
const state=r=>r.status!=="completed"?["k-warn",r.status==="queued"?"Queued":"Running"]:r.conclusion==="success"?["k-good","Passed"]:/cancel|skip/.test(r.conclusion)?["","Cancelled"]:["k-bad","Failed"];
cmd.onData(runs=>{
  if(!Array.isArray(runs)||!runs.length){dot.className="k-dot";result.textContent="No runs";subject.textContent="acme/shop has no workflow runs yet";rows.replaceChildren();return;}
  const [c,word]=state(runs[0]);
  dot.className="k-dot "+c;result.textContent=word;
  subject.textContent=`${runs[0].workflowName} #${runs[0].number} · ${runs[0].headBranch} · ${runs[0].displayTitle}`;
  rows.replaceChildren(...runs.map(r=>{
    const [c,word]=state(r),tr=document.createElement("tr");
    tr.innerHTML=`<td><span class="k-dot ${c}" title="${word}"></span></td><td class="k-text k-ellipsis t"><a href="${esc(r.url)}">${esc(r.displayTitle)}</a></td><td class="k-hide-narrow k-dim">${esc(r.headBranch)}</td><td class="k-num k-dim">${cmd.fmt.ago(r.createdAt)}</td>`;
    return tr;
  }));
});
</script>

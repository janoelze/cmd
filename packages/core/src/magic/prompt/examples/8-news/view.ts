import type { Data } from "./data.ts";

const list = document.getElementById("list")!;

cmd.onData<Data>((d) => {
  if (!d.stories.length) {
    list.innerHTML = '<li class="k-empty">No stories in the last day</li>';
    return;
  }
  list.replaceChildren(
    ...d.stories.map((st) => {
      const li = document.createElement("li");
      li.className = "story";
      const a = document.createElement("a");
      a.href = st.link;
      a.className = "k-ellipsis";
      a.textContent = st.title;
      const meta = document.createElement("div");
      meta.className = "k-small k-dim k-ellipsis";
      meta.textContent = `${st.source}${st.at ? " · " + cmd.fmt.ago(st.at) : ""}`;
      li.append(a, meta);
      return li;
    }),
  );
});

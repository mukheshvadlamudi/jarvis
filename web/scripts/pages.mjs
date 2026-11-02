// Extra pages for the screenshot gate, contributed per phase. `json(path)` fetches from the server.
export async function pages(json, base) {
  // A fresh mock write task, so the Outputs panel shows real files (draft.md, traffic.csv).
  let write = null;
  if (base) {
    const r = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Write the October traffic summary for the shop', type: 'write', agent_pref: 'claude' }) }).then((x) => x.json());
    for (let i = 0; i < 90 && r.task; i++) {
      const t = (await json(`/api/tasks/${r.task.id}`)).task;
      if (t.status === 'done' || t.status === 'failed') {
        write = t;
        break;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  return [
    ...(write
      ? [
          { name: 'run-outputs', path: `/tasks/${write.id}`, click: '.panel:has(h2:text("Outputs")) .row >> nth=0', wait: 2000 },
          { name: 'run-outputs-csv', path: `/tasks/${write.id}`, click: '.panel:has(h2:text("Outputs")) .row >> nth=1', wait: 2000 },
        ]
      : []),
    { name: 'more', path: '/more' },
    { name: 'memory', path: '/memory?note=Projects%2FClientEasy.md' },
    { name: 'memory-search', path: '/memory?q=deposit' },
    { name: 'memory-proposals', path: '/memory?tab=proposals' },
    { name: 'memory-health', path: '/memory?tab=health' },
    { name: 'skills', path: '/skills' },
    { name: 'schedules', path: '/schedules' },
    { name: 'research', path: '/research' },
    { name: 'updates', path: '/updates' },
    { name: 'projects', path: '/projects' },
    { name: 'people', path: '/people' },
    { name: 'setup', path: '/setup' },
    { name: 'schedule-editor', path: '/schedules', click: 'text=New schedule' },
  ];
}

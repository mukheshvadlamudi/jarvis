// Extra pages for the screenshot gate, contributed per phase. `json(path)` fetches from the server.
export async function pages() {
  return [
    { name: 'more', path: '/more' },
    { name: 'memory', path: '/memory?note=Projects%2FClientEasy.md' },
    { name: 'memory-search', path: '/memory?q=deposit' },
    { name: 'memory-proposals', path: '/memory?tab=proposals' },
    { name: 'memory-health', path: '/memory?tab=health' },
    { name: 'skills', path: '/skills' },
    { name: 'schedules', path: '/schedules' },
    { name: 'schedule-editor', path: '/schedules', click: 'text=New schedule' },
  ];
}

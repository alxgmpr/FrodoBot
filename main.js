const Worker = require('./worker.js');
const profiles = require('./profiles.js');

const workers = [];
profiles.forEach((profile) => {
  const w = new Worker(profile);
  w.run();
  workers.push(w);
});

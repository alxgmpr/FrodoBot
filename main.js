const Worker = require('./worker.js');
const profiles = require('./profiles.js');

const workers = [];
let counter = 0;
setInterval(() => {
  if (counter < profiles.length) {
    const w = new Worker(profiles[counter]);
    w.run();
    workers.push(w);
    counter += 1;
  }
}, 1000);

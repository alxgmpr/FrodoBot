'use strict';

const Worker = require('./worker.js');
const profiles = require('./profiles.example.js');

let workers = [];
profiles.forEach((profile) => {
    let w = new Worker(profile);
    w.run();
    workers.push(w);
});

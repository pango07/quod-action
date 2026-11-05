'use strict'

// Start independent cache operations together, but retain each one's
// failure policy and wait for every upload before the runner can exit.
async function saveTogether(tasks) {
  return Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)))
}
module.exports = { saveTogether }

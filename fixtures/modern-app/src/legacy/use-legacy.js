// CommonJS consumer: require() of a CommonJS module and an ES module.
const { formatName } = require('./cjs-module');
const { describePrice } = require('./esm.mjs');

function greet(first, last) {
  return `${formatName(first, last)} ${describePrice(1)}`;
}

module.exports = { greet };

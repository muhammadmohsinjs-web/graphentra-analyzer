// CommonJS module: declared function re-exported through module.exports, plus an exports.* arrow.
function formatName(first, last) {
  return `${last}, ${first}`;
}

exports.shout = (s) => s.toUpperCase() + '!';

module.exports.formatName = formatName;

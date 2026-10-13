let seq = 0;

const counter = () => {
  seq += 1;
  return String(seq);
};

export const makeId = (prefix: string) => prefix + '-' + counter();

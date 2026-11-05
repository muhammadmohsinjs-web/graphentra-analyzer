import type { Res } from '../../src/server/router';

export interface Captured {
  code: number;
  body: unknown;
}

// Records the status code and body the handler sends back.
export const fakeRes = () => {
  const out: Captured = { code: 200, body: undefined };
  const res: Res = {
    status(code) {
      out.code = code;
      return res;
    },
    json(data) {
      out.body = data;
    },
    send(text) {
      out.body = text;
    },
  };
  return { res, out };
};

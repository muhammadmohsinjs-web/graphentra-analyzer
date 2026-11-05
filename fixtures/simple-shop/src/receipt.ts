const firstName = (fullName: string): string => fullName.split(' ')[0];

export const buildReceipt = (fullName: string, code: string): string =>
  `Thanks ${firstName(fullName)}! Your ${code} is on its way.`;

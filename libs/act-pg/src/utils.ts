/**
 * Date reviver when parsing JSON strings with the following formats:
 * - YYYY-MM-DDTHH:MM:SS.sssZ
 * - YYYY-MM-DDTHH:MM:SS.sss+HH:MM
 * - YYYY-MM-DDTHH:MM:SS.sss-HH:MM
 */
const ISO_8601 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d+)?(Z|[+-][0-2][0-9]:[0-5][0-9])?$/;
export const dateReviver = (key: string, value: string): string | Date => {
  if (typeof value === "string" && ISO_8601.test(value)) {
    try {
      return new Date(value);
    } catch {
      return value;
    }
  }
  return value;
};

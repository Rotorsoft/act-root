/**
 * @module act-pg
 * Date reviver for JSON.parse to automatically convert ISO 8601 date strings to Date objects.
 *
 * Recognizes the following formats:
 * - YYYY-MM-DDTHH:MM:SS.sssZ
 * - YYYY-MM-DDTHH:MM:SS.sss+HH:MM
 * - YYYY-MM-DDTHH:MM:SS.sss-HH:MM
 *
 * @param key The key being parsed
 * @param value The value being parsed
 * @returns A Date object if the value matches ISO 8601, otherwise the original value
 *
 * @example
 * const obj = JSON.parse(jsonString, dateReviver);
 */
const ISO_8601 =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d+)?(Z|[+-][0-2][0-9]:[0-5][0-9])?$/;
export const dateReviver = (key: string, value: string): string | Date => {
  if (typeof value === "string" && ISO_8601.test(value)) {
    return new Date(value);
  }
  return value;
};

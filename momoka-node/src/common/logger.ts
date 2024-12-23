export type LogFunctionType = (message: string, ...optionalParams: unknown[]) => void;

export enum LoggerLevelColours {
  INFO = '\x1b[36m',
  SUCCESS = '\x1b[38;2;0;128;0m',
  ERROR = '\x1b[31m',
  WARNING = '\x1b[33m',
}

/**
 *  A function to build a log message with the lens node footprint.
 * @param message The message
 */
export const buildLensNodeFootprintLog = (message: string): string => {
  return `[${new Date().toUTCString()}] LENS VERIFICATION NODE - ${message}`;
};

/**
 * A function to log a message to the console with a info font color.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleLog = (message: string, ...optionalParams: unknown[]): void => {
  console.log(
    LoggerLevelColours.INFO,
    `[${new Date().toUTCString()}] ${message}`,
    ...optionalParams
  );
};

/**
 * A function to log a message to the console with a info font color including the lens node footprint.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleLogWithLensNodeFootprint = (
  message: string,
  ...optionalParams: unknown[]
): void => {
  console.log(LoggerLevelColours.INFO, buildLensNodeFootprintLog(message), ...optionalParams);
};

/**
 * A function to log a message to the console with a green font color.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleSuccess = (message: string, ...optionalParams: unknown[]): void => {
  console.log(
    LoggerLevelColours.SUCCESS,
    `[${new Date().toUTCString()}] ${message}`,
    ...optionalParams
  );
};

/**
 * A function to log a error message to the console with a red font color.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleError = (message: string, ...optionalParams: unknown[]): void => {
  console.log(
    LoggerLevelColours.ERROR,
    `[${new Date().toUTCString()}] ${message}`,
    ...optionalParams
  );
};

/**
 * A function to log a warning message to the console with a yellow font color.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleWarn = (message: string, ...optionalParams: unknown[]): void => {
  console.log(
    LoggerLevelColours.WARNING,
    `[${new Date().toUTCString()}] ${message}`,
    ...optionalParams
  );
};

/**
 * A function to log a message to the console with a dynamic font color.
 * @param message - The message to be logged to the console.
 * @param optionalParams - An optional list of additional parameters to be logged to the console.
 */
export const consoleDynamic = (
  color: LoggerLevelColours,
  message: string,
  ...optionalParams: unknown[]
): void => {
  console.log(color, `[${new Date().toUTCString()}] ${message}`, ...optionalParams);
};

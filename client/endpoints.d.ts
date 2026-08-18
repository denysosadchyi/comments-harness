/* Типи до `endpoints.js`. Файл лишається звичайним JS, бо його вантажить не
   лише збірник оверлея, а й рев'ю-сторінка — голим `import()` зі статики, де
   ніякого TypeScript немає й не буде. Декларація існує рівно для того, щоб
   `tsc` проєкту-господаря бачив імпорт із `.tsx`. */
export declare const DEFAULT_NOTES_PORT: number

export interface HarnessEndpoints {
  /** База сервера нот, `http://<хост>:<порт>`. Завжди непорожня. */
  notes: string
  /** База сервера вердиктів. Порожній рядок = порт невідомий (сервер нот не
   *  відповів і підказки зі статики немає). */
  ratings: string
  /** Чи відповів сервер нот на `GET /config`. */
  live: boolean
}

export declare function resolveEndpoints(hostname?: string): Promise<HarnessEndpoints>

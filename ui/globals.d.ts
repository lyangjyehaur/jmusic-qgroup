export {};
declare global {
  var BoardAnalytics:
    | {
        request(
          path: string,
          method: string,
          status: number,
          outcome: string,
        ): void;
      }
    | undefined;
}

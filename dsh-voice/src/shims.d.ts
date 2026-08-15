declare const Buffer: {
  byteLength(s: string): number
  from(data: Uint8Array): Uint8Array
  concat(list: Uint8Array[]): Uint8Array
}
declare const process: {
  platform: string
  env: Record<string, string | undefined>
  cwd(): string
  pid: number
}
declare namespace NodeJS {
  interface Timeout {}
}

declare module '*?base64' {
  const value: string;
  export = value;
}

declare module 'qrcode-terminal' {
  type QrcodeTerminalGenerateOptions = {
    small?: boolean | undefined;
  };

  const qrcodeTerminal: {
    generate(
      payload: string,
      optionsOrCallback?: QrcodeTerminalGenerateOptions | ((qr: string) => void),
      callback?: (qr: string) => void,
    ): void;
  };

  export default qrcodeTerminal;
}

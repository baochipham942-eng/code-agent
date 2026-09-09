declare module 'noise-handshake' {
  export interface KeyPair { publicKey: Uint8Array; secretKey: Uint8Array }
  export default class Noise {
    constructor(pattern: 'XXpsk0' | 'IK', initiator: boolean, keyPair?: KeyPair, options?: { psk?: Uint8Array });
    s: KeyPair; e: KeyPair | null; rs: Uint8Array | null; tx: Uint8Array; rx: Uint8Array; complete: boolean;
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;
    send(payload?: Uint8Array): Uint8Array;
    recv(frame: Uint8Array): Uint8Array;
  }
}
declare module 'noise-handshake/cipher' {
  export default class Cipher {
    constructor(key: Uint8Array);
    encrypt(payload: Uint8Array): Uint8Array;
    decrypt(frame: Uint8Array): Uint8Array;
    _clear(): void;
  }
}

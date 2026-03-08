// Patched IR receiver for the StemBit NEC remote.
// Based on the MakerBit IR receiver library, but adjusted for:
// 1) standard NEC byte order (LSB-first on the wire)
// 2) StemBit remote button codes
// 3) slightly wider timing tolerance and better repeat handling
// 4) micro:bit v1/v2 compatibility (TypeScript-only)

const enum IrButton {
  //% block="any"
  Any = -1,
  // StemBit remote button codes from the working decoder
  //% block="power"
  Power = 0x00,
  //% block="up"
  Up = 0x01,
  //% block="light"
  Light = 0x02,
  //% block="left"
  Left = 0x04,
  //% block="beep"
  BEEP = 0x05,
  //% block="right"
  Right = 0x06,
  //% block="turn left"
  TurnLeft = 0x08,
  //% block="down"
  Down = 0x09,
  //% block="turn right"
  TurnRight = 0x0A,
  //% block="plus"
  Plus = 0x0C,
  //% block="0"
  Number_0 = 0x0D,
  //% block="minus"
  Minus = 0x0E,
  //% block="1"
  Number_1 = 0x10,
  //% block="2"
  Number_2 = 0x11,
  //% block="3"
  Number_3 = 0x12,
  //% block="4"
  Number_4 = 0x14,
  //% block="5"
  Number_5 = 0x15,
  //% block="6"
  Number_6 = 0x16,
  //% block="7"
  Number_7 = 0x18,
  //% block="8"
  Number_8 = 0x19,
  //% block="9"
  Number_9 = 0x1A,
}

const enum IrButtonAction {
  //% block="pressed"
  Pressed = 0,
  //% block="released"
  Released = 1,
}

const enum IrProtocol {
  //% block="StemBit NEC"
  NEC = 1,
}

//% color=#0fbc11 icon="\u272a" block="StemBit IR"
//% category="StemBit IR"
namespace makerbit {
  let irState: IrState;

  const IR_REPEAT = 256;
  const IR_INCOMPLETE = 257;
  const IR_DATAGRAM = 258;

  // A slightly longer timeout feels better with cheap remotes/receivers.
  const REPEAT_TIMEOUT_MS = 180;

  interface IrState {
    protocol: IrProtocol;
    hasNewDatagram: boolean;
    bitsReceived: uint8;
    addressSectionBits: uint16;
    commandSectionBits: uint16;
    hiword: uint16;
    loword: uint16;
    activeCommand: number;
    lastCommand: number;
    repeatTimeout: number;
    onIrButtonPressed: IrButtonHandler[];
    onIrButtonReleased: IrButtonHandler[];
    onIrDatagram: () => void;
  }

  class IrButtonHandler {
    irButton: IrButton;
    onEvent: () => void;

    constructor(irButton: IrButton, onEvent: () => void) {
      this.irButton = irButton;
      this.onEvent = onEvent;
    }
  }

  function reverseBits8(value: number): number {
    let reversed = 0;
    for (let i = 0; i < 8; i++) {
      reversed = (reversed << 1) | (value & 0x01);
      value = value >> 1;
    }
    return reversed & 0xFF;
  }

  function normalizedNecAddress(): number {
    return reverseBits8((irState.addressSectionBits >> 8) & 0xFF);
  }

  function normalizedNecInverseAddress(): number {
    return reverseBits8(irState.addressSectionBits & 0xFF);
  }

  function normalizedNecCommand(): number {
    return reverseBits8((irState.commandSectionBits >> 8) & 0xFF);
  }

  function normalizedNecInverseCommand(): number {
    return reverseBits8(irState.commandSectionBits & 0xFF);
  }

  function hasValidNecCommandChecksum(): boolean {
    const cmd = normalizedNecCommand();
    const inv = normalizedNecInverseCommand();
    return ((cmd ^ inv) & 0xFF) === 0xFF;
  }

  function appendBitToDatagram(bit: number): number {
    irState.bitsReceived += 1;

    if (irState.bitsReceived <= 8) {
      irState.hiword = (irState.hiword << 1) + bit;
    } else if (irState.bitsReceived <= 16) {
      irState.hiword = (irState.hiword << 1) + bit;
    } else if (irState.bitsReceived <= 32) {
      irState.loword = (irState.loword << 1) + bit;
    }

    if (irState.bitsReceived === 32) {
      irState.addressSectionBits = irState.hiword & 0xFFFF;
      irState.commandSectionBits = irState.loword & 0xFFFF;
      return IR_DATAGRAM;
    } else {
      return IR_INCOMPLETE;
    }
  }

  function decode(markAndSpace: number): number {
    // NEC bit timings after demodulation are roughly:
    // 0-bit: 560 + 560 = ~1120us
    // 1-bit: 560 + 1690 = ~2250us
    // Repeat: 9000 + 2250 = ~11250us
    // Start:  9000 + 4500 = ~13500us
    if (markAndSpace >= 800 && markAndSpace < 1800) {
      return appendBitToDatagram(0);
    } else if (markAndSpace >= 1800 && markAndSpace < 3000) {
      return appendBitToDatagram(1);
    }

    irState.bitsReceived = 0;
    irState.hiword = 0;
    irState.loword = 0;

    if (markAndSpace >= 10000 && markAndSpace < 13000) {
      return IR_REPEAT;
    } else if (markAndSpace >= 12500 && markAndSpace < 15000) {
      return IR_INCOMPLETE;
    } else {
      return IR_INCOMPLETE;
    }
  }

  function enableIrMarkSpaceDetection(pin: DigitalPin) {
    // Pull-up tends to behave better with the common 3-pin demodulated IR modules.
    pins.setPull(pin, PinPullMode.PullUp);

    let mark = 0;
    let space = 0;

    pins.onPulsed(pin, PulseValue.Low, () => {
      mark = pins.pulseDuration();
    });

    pins.onPulsed(pin, PulseValue.High, () => {
      space = pins.pulseDuration();
      const status = decode(mark + space);
      if (status !== IR_INCOMPLETE) {
        handleIrEvent(status);
      }
    });
  }

  function forEachMatchingHandler(handlers: IrButtonHandler[], button: number) {
    for (let i = 0; i < handlers.length; i++) {
      const h = handlers[i];
      if (h.irButton === button || h.irButton === IrButton.Any) {
        background.schedule(h.onEvent, background.Thread.UserCallback, background.Mode.Once, 0);
      }
    }
  }

  function handleIrEvent(irEvent: number) {
    if (irEvent === IR_DATAGRAM || irEvent === IR_REPEAT) {
      irState.repeatTimeout = input.runningTime() + REPEAT_TIMEOUT_MS;
    }

    if (irEvent === IR_REPEAT) {
      return;
    }

    if (irEvent === IR_DATAGRAM) {
      if (!hasValidNecCommandChecksum()) {
        return;
      }

      irState.hasNewDatagram = true;
      if (irState.onIrDatagram) {
        background.schedule(irState.onIrDatagram, background.Thread.UserCallback, background.Mode.Once, 0);
      }

      const newCommand = normalizedNecCommand();
      irState.lastCommand = newCommand;

      if (newCommand !== irState.activeCommand) {
        if (irState.activeCommand >= 0) {
          forEachMatchingHandler(irState.onIrButtonReleased, irState.activeCommand);
        }

        forEachMatchingHandler(irState.onIrButtonPressed, newCommand);
        irState.activeCommand = newCommand;
      }
    }
  }

  function initIrState() {
    if (irState) {
      return;
    }

    irState = {
      protocol: undefined,
      bitsReceived: 0,
      hasNewDatagram: false,
      addressSectionBits: 0,
      commandSectionBits: 0,
      hiword: 0,
      loword: 0,
      activeCommand: -1,
      lastCommand: -1,
      repeatTimeout: 0,
      onIrButtonPressed: [],
      onIrButtonReleased: [],
      onIrDatagram: undefined,
    };
  }

  /**
   * Connects to the IR receiver module at the specified pin.
   * @param pin IR receiver pin, eg: DigitalPin.P0
   * @param protocol IR protocol, eg: IrProtocol.NEC
   */
  //% subcategory="IR Receiver"
  //% blockId="makerbit_infrared_connect_receiver"
  //% block="connect IR receiver at pin %pin and decode %protocol"
  //% pin.fieldEditor="gridpicker"
  //% pin.fieldOptions.columns=4
  //% pin.fieldOptions.tooltips="false"
  //% weight=90
  export function connectIrReceiver(pin: DigitalPin, protocol: IrProtocol): void {
    initIrState();

    if (irState.protocol !== undefined) {
      return;
    }

    irState.protocol = protocol;
    enableIrMarkSpaceDetection(pin);
    background.schedule(notifyIrEvents, background.Thread.Priority, background.Mode.Repeat, REPEAT_TIMEOUT_MS);
  }

  function notifyIrEvents() {
    if (irState.activeCommand === -1) {
      return;
    }

    const now = input.runningTime();
    if (now > irState.repeatTimeout) {
      forEachMatchingHandler(irState.onIrButtonReleased, irState.activeCommand);
      irState.bitsReceived = 0;
      irState.hiword = 0;
      irState.loword = 0;
      irState.activeCommand = -1;
    }
  }

  /**
   * Do something when a specific button is pressed or released on the remote control.
   * @param button the button to be checked
   * @param action the trigger action
   * @param handler body code to run when the event is raised
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_on_ir_button
  //% block="on IR button | %button | %action"
  //% button.fieldEditor="gridpicker"
  //% button.fieldOptions.columns=3
  //% button.fieldOptions.tooltips="false"
  //% weight=50
  export function onIrButton(button: IrButton, action: IrButtonAction, handler: () => void) {
    initIrState();
    if (action === IrButtonAction.Pressed) {
      irState.onIrButtonPressed.push(new IrButtonHandler(button, handler));
    } else {
      irState.onIrButtonReleased.push(new IrButtonHandler(button, handler));
    }
  }

  /**
   * Returns the code of the IR button that was pressed last.
   * Returns -1 (IrButton.Any) if no button has been pressed yet.
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_ir_button_pressed
  //% block="IR button"
  //% weight=70
  export function irButton(): number {
    basic.pause(0);
    if (!irState) {
      return IrButton.Any;
    }
    if (irState.activeCommand >= 0) {
      return irState.activeCommand;
    }
    return irState.lastCommand;
  }

  /**
   * Do something when an IR datagram is received.
   * @param handler body code to run when the event is raised
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_on_ir_datagram
  //% block="on IR datagram received"
  //% weight=40
  export function onIrDatagram(handler: () => void) {
    initIrState();
    irState.onIrDatagram = handler;
  }

  /**
   * Returns the IR datagram as 32-bit hexadecimal string.
   * For NEC, the bytes are returned in the normal on-the-wire order: addr, ~addr, cmd, ~cmd.
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_ir_datagram
  //% block="IR datagram"
  //% weight=30
  export function irDatagram(): string {
    basic.pause(0);
    initIrState();
    const addr = normalizedNecAddress();
    const naddr = normalizedNecInverseAddress();
    const cmd = normalizedNecCommand();
    const ncmd = normalizedNecInverseCommand();
    return "0x" + ir_rec_to8BitHex(addr) + ir_rec_to8BitHex(naddr) + ir_rec_to8BitHex(cmd) + ir_rec_to8BitHex(ncmd);
  }

  /**
   * Returns true if any IR data was received since the last call of this function.
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_was_any_ir_datagram_received
  //% block="IR data was received"
  //% weight=80
  export function wasIrDataReceived(): boolean {
    basic.pause(0);
    initIrState();
    if (irState.hasNewDatagram) {
      irState.hasNewDatagram = false;
      return true;
    }
    return false;
  }

  /**
   * Returns the command code of a specific IR button.
   * @param button the button
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_button_code
  //% button.fieldEditor="gridpicker"
  //% button.fieldOptions.columns=3
  //% button.fieldOptions.tooltips="false"
  //% block="IR button code %button"
  //% weight=60
  export function irButtonCode(button: IrButton): number {
    basic.pause(0);
    return button as number;
  }

  function ir_rec_to8BitHex(value: number): string {
    let hex = "";
    for (let pos = 0; pos < 2; pos++) {
      const remainder = value % 16;
      if (remainder < 10) {
        hex = remainder.toString() + hex;
      } else {
        hex = String.fromCharCode(55 + remainder) + hex;
      }
      value = Math.idiv(value, 16);
    }
    return hex;
  }
}

// MakerBit-style IR receiver blocks adapted for the StemBit NEC remote
// Decoder logic aligned with the working StemBit main.ts implementation

const enum IrButton {
  //% block="any"
  Any = -1,
  //% block="power"
  Power = 0x00,
  //% block="up"
  Up = 0x01,
  //% block="light"
  Light = 0x02,
  //% block="left"
  Left = 0x04,
  //% block="beep"
  Beep = 0x05,
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

//% color=#0fbc11 icon="\u272a" block="MakerBit"
//% category="MakerBit"
namespace makerbit {
  let irState: IrState;

  const IR_REPEAT = 256;
  const IR_INCOMPLETE = 257;
  const IR_DATAGRAM = 258;

  // Thresholds taken from the working StemBit decoder
  const LEADER_LOW_MIN = 7000;
  const LEADER_HIGH_MIN = 3000;
  const REPEAT_HIGH_MIN = 1800;
  const REPEAT_HIGH_MAX = 2800;
  const BIT_HIGH_ONE_MIN = 1000;
  const NOISE_HIGH_MIN = 200;
  const REPEAT_TIMEOUT_MS = 250;

  interface IrState {
    protocol: number;
    hasNewDatagram: boolean;
    bitsReceived: number;
    addressSectionBits: number;
    commandSectionBits: number;
    hiword: number;
    loword: number;
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

  function appendBitToDatagram(bit: number): number {
    const bitIndex = irState.bitsReceived;

    if (bitIndex < 16) {
      if (bit) {
        irState.hiword |= (1 << bitIndex);
      }
    } else if (bitIndex < 32) {
      if (bit) {
        irState.loword |= (1 << (bitIndex - 16));
      }
    } else {
      resetDatagram();
      return IR_INCOMPLETE;
    }

    irState.bitsReceived = bitIndex + 1;

    if (irState.bitsReceived === 32) {
      irState.addressSectionBits = irState.hiword & 0xffff;
      irState.commandSectionBits = irState.loword & 0xffff;
      return validateDatagram() ? IR_DATAGRAM : IR_INCOMPLETE;
    }

    return IR_INCOMPLETE;
  }

  function validateDatagram(): boolean {
    const addr = irState.addressSectionBits & 0xff;
    const naddr = (irState.addressSectionBits >> 8) & 0xff;
    const cmd = irState.commandSectionBits & 0xff;
    const ncmd = (irState.commandSectionBits >> 8) & 0xff;

    if (((addr ^ naddr) & 0xff) !== 0xff) {
      resetDatagram();
      return false;
    }
    if (((cmd ^ ncmd) & 0xff) !== 0xff) {
      resetDatagram();
      return false;
    }

    irState.lastCommand = cmd;
    return true;
  }

  function resetDatagram() {
    irState.bitsReceived = 0;
    irState.hiword = 0;
    irState.loword = 0;
    irState.addressSectionBits = 0;
    irState.commandSectionBits = 0;
  }

  function decode(mark: number, space: number): number {
    if (mark >= LEADER_LOW_MIN) {
      resetDatagram();

      if (space >= REPEAT_HIGH_MIN && space <= REPEAT_HIGH_MAX) {
        return IR_REPEAT;
      }
      if (space >= LEADER_HIGH_MIN) {
        return IR_INCOMPLETE;
      }
      return IR_INCOMPLETE;
    }

    if (space < NOISE_HIGH_MIN) {
      return IR_INCOMPLETE;
    }

    return appendBitToDatagram(space >= BIT_HIGH_ONE_MIN ? 1 : 0);
  }

  function enableIrMarkSpaceDetection(pin: DigitalPin) {
    pins.setPull(pin, PinPullMode.PullUp);

    let mark = 0;

    pins.onPulsed(pin, PulseValue.Low, () => {
      mark = pins.pulseDuration();
    });

    pins.onPulsed(pin, PulseValue.High, () => {
      const space = pins.pulseDuration();
      const status = decode(mark, space);
      if (status !== IR_INCOMPLETE) {
        handleIrEvent(status);
      }
    });
  }

  function runHandler(list: IrButtonHandler[], button: number) {
    const handler = list.find(h => h.irButton === button || h.irButton === IrButton.Any);
    if (handler) {
      background.schedule(handler.onEvent, background.Thread.UserCallback, background.Mode.Once, 0);
    }
  }

  function handleIrEvent(irEvent: number) {
    if (irEvent === IR_DATAGRAM || irEvent === IR_REPEAT) {
      irState.repeatTimeout = input.runningTime() + REPEAT_TIMEOUT_MS;
    }

    if (irEvent === IR_REPEAT) {
      if (irState.lastCommand >= 0 && irState.activeCommand === -1) {
        irState.activeCommand = irState.lastCommand;
        runHandler(irState.onIrButtonPressed, irState.activeCommand);
      }
      return;
    }

    if (irEvent !== IR_DATAGRAM) {
      return;
    }

    irState.hasNewDatagram = true;

    if (irState.onIrDatagram) {
      background.schedule(irState.onIrDatagram, background.Thread.UserCallback, background.Mode.Once, 0);
    }

    const newCommand = irState.lastCommand;

    if (newCommand !== irState.activeCommand) {
      if (irState.activeCommand >= 0) {
        runHandler(irState.onIrButtonReleased, irState.activeCommand);
      }
      runHandler(irState.onIrButtonPressed, newCommand);
      irState.activeCommand = newCommand;
    }
  }

  function initIrState() {
    if (irState) {
      return;
    }

    irState = {
      protocol: -1,
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
   * Connects to the IR receiver module at the specified pin and configures NEC decoding.
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

    if (irState.protocol !== -1) {
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
      runHandler(irState.onIrButtonReleased, irState.activeCommand);
      resetDatagram();
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
   * Returns the code of the IR button that was pressed last. Returns -1 (IrButton.Any) if no button has been pressed yet.
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
   * The last received datagram is returned or "0x00000000" if no data has been received yet.
   */
  //% subcategory="IR Receiver"
  //% blockId=makerbit_infrared_ir_datagram
  //% block="IR datagram"
  //% weight=30
  export function irDatagram(): string {
    basic.pause(0);
    initIrState();
    const addr = irState.addressSectionBits & 0xff;
    const naddr = (irState.addressSectionBits >> 8) & 0xff;
    const cmd = irState.commandSectionBits & 0xff;
    const ncmd = (irState.commandSectionBits >> 8) & 0xff;
    return "0x" + to8BitHex(addr) + to8BitHex(naddr) + to8BitHex(cmd) + to8BitHex(ncmd);
  }

  /**
   * Returns true if any IR data was received since the last call of this function. False otherwise.
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

  function to8BitHex(value: number): string {
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

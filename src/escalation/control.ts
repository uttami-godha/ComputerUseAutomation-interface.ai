// Explicit control-transfer model. Automation and human never act concurrently.
// A handoff is a state transition with evidence, not an out-of-band side channel.

export type ControlOwner = "automation" | "human";

export type ControlTransfer = {
  from: ControlOwner;
  to: ControlOwner;
  reason: string;
  at: string;
};

export class Control {
  private current: ControlOwner = "automation";
  private history: ControlTransfer[] = [];

  owner(): ControlOwner {
    return this.current;
  }

  isAutomation(): boolean {
    return this.current === "automation";
  }

  isHuman(): boolean {
    return this.current === "human";
  }

  transfer(
    to: ControlOwner,
    reason: string,
  ): ControlTransfer {
    const event: ControlTransfer = {
      from: this.current,
      to,
      reason,
      at: new Date().toISOString(),
    };

    this.current = to;
    this.history.push(event);

    return event;
  }

  toHuman(reason: string): ControlTransfer {
    return this.transfer("human", reason);
  }

  toAutomation(reason: string): ControlTransfer {
    return this.transfer("automation", reason);
  }

  transfers(): readonly ControlTransfer[] {
    return this.history;
  }
}
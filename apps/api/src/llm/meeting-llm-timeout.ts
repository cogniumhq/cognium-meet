import {
  meetingAskTimeoutMessage,
  meetingAskTimeoutMs,
  type MeetingLlmProvider,
} from "@cognium/meet-shared";

export class MeetingLlmTimeoutError extends Error {
  readonly provider: MeetingLlmProvider;

  constructor(provider: MeetingLlmProvider) {
    super(meetingAskTimeoutMessage(provider));
    this.name = "MeetingLlmTimeoutError";
    this.provider = provider;
  }
}

export async function withMeetingLlmTimeout<T>(
  provider: MeetingLlmProvider,
  promise: Promise<T>,
): Promise<T> {
  const ms = meetingAskTimeoutMs(provider);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new MeetingLlmTimeoutError(provider));
        }, ms);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

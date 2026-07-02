import { ax } from "@ax-llm/ax";
import type {
  MeetingAskCitation,
  MeetingAskMessage,
  MeetingLlmProvider,
} from "@cognium/meet-shared";
import { formatMeetingAskConversation } from "@cognium/meet-shared";
import type { MeetingLlmConfig } from "../llm/create-meeting-llm.js";
import { createMeetingLlm, resolveMeetingLlmModel } from "../llm/create-meeting-llm.js";

const meetingAskGen = ax(
  `conversation:string, context:string -> answer:string, insufficientContext:boolean`,
  {
    description:
      "Answer the user's latest message in the conversation using ONLY the meeting transcripts and notes in context. Prior turns are for follow-ups (e.g. 'what about pricing?'). Be concise. Name which meeting(s) you draw from when relevant. If context lacks enough information, explain what is missing and set insufficientContext to true.",
  },
);

export async function answerMeetingQuestion(opts: {
  llmConfig: MeetingLlmConfig;
  llmProvider?: MeetingLlmProvider;
  model: string;
  messages: MeetingAskMessage[];
  context: string;
  citations: MeetingAskCitation[];
}): Promise<{
  answer: string;
  insufficientContext: boolean;
  citations: MeetingAskCitation[];
}> {
  if (!opts.context.trim()) {
    return {
      answer:
        "I don't have any completed meeting transcripts to search yet. Record and transcribe a meeting first.",
      insufficientContext: true,
      citations: [],
    };
  }

  const llm = createMeetingLlm(opts.llmConfig, opts.llmProvider);
  const model = resolveMeetingLlmModel(opts.llmConfig, opts.model, opts.llmProvider);

  const result = await meetingAskGen.forward(
    llm,
    {
      conversation: formatMeetingAskConversation(opts.messages),
      context: opts.context,
    },
    { model },
  );

  return {
    answer: result.answer?.trim() || "No answer generated.",
    insufficientContext: Boolean(result.insufficientContext),
    citations: opts.citations,
  };
}

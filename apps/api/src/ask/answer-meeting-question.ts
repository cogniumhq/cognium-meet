import { ai, ax } from "@ax-llm/ax";
import type { MeetingAskCitation } from "@cognium/meet-shared";

const meetingAskGen = ax(
  `question:string, context:string -> answer:string, insufficientContext:boolean`,
  {
    description:
      "Answer the user's question using ONLY the meeting transcripts and notes in context. Be concise and specific. Name which meeting(s) your answer draws from when relevant. If the context does not contain enough information, explain what is missing and set insufficientContext to true.",
  },
);

export async function answerMeetingQuestion(opts: {
  apiKey: string;
  model: string;
  question: string;
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

  const llm = ai({ name: "openai", apiKey: opts.apiKey });

  const result = await meetingAskGen.forward(
    llm,
    {
      question: opts.question.trim(),
      context: opts.context,
    },
    { model: opts.model },
  );

  return {
    answer: result.answer?.trim() || "No answer generated.",
    insufficientContext: Boolean(result.insufficientContext),
    citations: opts.citations,
  };
}

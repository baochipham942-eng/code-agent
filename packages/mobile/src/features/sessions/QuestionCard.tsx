import { useState } from 'react';
import type { messages } from '../../i18n';

interface QuestionOption {
  label?: string;
  description?: string;
  recommended?: boolean;
}

interface Question {
  question?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export function QuestionCard({ card, text, disabled, respond, skip }: {
  card: Record<string, unknown>;
  text: ReturnType<typeof messages>;
  disabled: boolean;
  respond: (answers: Record<string, string | string[]>) => Promise<void>;
  skip: (reason?: string) => Promise<void>;
}) {
  let questions: Question[] = [];
  try {
    const parsed = JSON.parse(String(card.preview ?? '')) as { questions?: Question[] };
    if (Array.isArray(parsed.questions)) questions = parsed.questions;
  } catch { /* An unreadable question cannot be answered. */ }
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const readable = questions.length > 0 && questions.every(question =>
    typeof question.question === 'string' && typeof question.header === 'string' && Array.isArray(question.options));

  const headerOf = (question: Question, index: number) => question.header || `q-${index}`;
  const selected = (header: string, label: string, multiSelect?: boolean) => {
    const answer = answers[header];
    return multiSelect ? Array.isArray(answer) && answer.includes(label) : answer === label;
  };
  const toggle = (header: string, label: string, multiSelect?: boolean) => {
    setAnswers(current => {
      if (multiSelect) {
        const existing = Array.isArray(current[header]) ? current[header] as string[] : [];
        return { ...current, [header]: existing.includes(label) ? existing.filter(item => item !== label) : [...existing, label] };
      }
      return { ...current, [header]: label };
    });
  };
  const answered = readable && questions.every((question, index) => {
    const header = headerOf(question, index);
    const other = (otherText[header] ?? '').trim();
    if (other) return true;
    const answer = answers[header];
    return question.multiSelect ? Array.isArray(answer) && answer.length > 0 : typeof answer === 'string' && answer.trim().length > 0;
  });
  const submit = () => {
    const next: Record<string, string | string[]> = {};
    questions.forEach((question, index) => {
      const header = headerOf(question, index);
      const other = (otherText[header] ?? '').trim();
      if (question.multiSelect) {
        const labels = Array.isArray(answers[header]) ? [...answers[header] as string[]] : [];
        if (other) labels.push(other);
        next[header] = labels;
      } else {
        next[header] = other || String(answers[header] ?? '');
      }
    });
    void respond(next);
  };

  return <section className="approval-card" aria-label={text.question}>
    <strong>{text.question}</strong>
    <div className="approval-details">
      {!readable && <p role="status">{text.unreadableQuestion}</p>}
      {questions.map((question, index) => {
        const header = headerOf(question, index);
        return <div key={header} className="question-block">
          <p>{question.question}</p>
          {question.multiSelect && <p className="caption">{text.questionMultiSelect}</p>}
          {(question.options ?? []).map(option => typeof option.label === 'string' && <button
            key={option.label}
            type="button"
            className={selected(header, option.label, question.multiSelect) ? 'option selected' : 'option'}
            disabled={disabled || card.status !== 'pending'}
            onClick={() => { setOtherText(current => ({ ...current, [header]: '' })); toggle(header, option.label!, question.multiSelect); }}
          >
            <span>{option.label}</span>
            {option.recommended && <small>{text.questionRecommended}</small>}
            {option.description && <small>{option.description}</small>}
          </button>)}
          <label className="question-other">{text.questionOther}
            <input
              value={otherText[header] ?? ''}
              disabled={disabled || card.status !== 'pending'}
              placeholder={text.questionOtherPlaceholder}
              onChange={event => {
                const value = event.target.value;
                setOtherText(current => ({ ...current, [header]: value }));
                if (!question.multiSelect && value.trim()) {
                  setAnswers(current => ({ ...current, [header]: '' }));
                }
              }}
            />
          </label>
        </div>;
      })}
    </div>
    {card.status === 'pending' ? <div className="approval-actions">
      <button disabled={disabled} onClick={() => void skip()}>{text.questionSkip}</button>
      <button disabled={disabled || !readable || !answered} onClick={submit}>{text.questionSubmit}</button>
    </div> : <p role="status">{text.questionClosed}</p>}
  </section>;
}

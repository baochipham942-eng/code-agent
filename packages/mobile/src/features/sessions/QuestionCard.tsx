import { useState } from 'react';
import type { messages } from '../../i18n';
import { cardOutcome, questionAnswers, questionDeclined } from './decisionCard';

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
  const pending = card.status === 'pending';
  const outcome = cardOutcome(card);
  const settledAnswers = questionAnswers(card);
  const declined = !pending && questionDeclined(card);
  const expired = outcome === 'expired';
  const cancelled = outcome === 'cancelled' || (!pending && !outcome && !settledAnswers && !declined && card.status === 'closed');
  const shownAnswers = pending ? answers : (settledAnswers ?? {});

  const headerOf = (question: Question, index: number) => question.header || `q-${index}`;
  const selected = (header: string, label: string, multiSelect?: boolean) => {
    const answer = shownAnswers[header];
    return multiSelect ? Array.isArray(answer) && answer.includes(label) : answer === label;
  };
  const optionLabels = (question: Question) => new Set((question.options ?? []).map(option => option.label).filter((label): label is string => typeof label === 'string'));
  const freeText = (question: Question, index: number) => {
    const header = headerOf(question, index);
    const answer = shownAnswers[header];
    const labels = optionLabels(question);
    if (question.multiSelect && Array.isArray(answer)) {
      const extra = answer.filter(item => !labels.has(item));
      return extra.length > 0 ? extra.join('、') : '';
    }
    return typeof answer === 'string' && answer.trim() && !labels.has(answer) ? answer : '';
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
  const resultCopy = expired ? text.questionExpired
    : cancelled ? text.questionCancelled
      : declined ? text.questionSkipped
        : settledAnswers ? null
          : card.status === 'approved' ? text.questionAnswered
            : null;

  return <section className="approval-card" aria-label={text.question} data-testid="question-card" data-outcome={outcome ?? (pending ? 'pending' : 'answered')}>
    <strong>{text.question}</strong>
    <div className="approval-details">
      {!readable && <p role="status">{text.unreadableQuestion}</p>}
      {questions.map((question, index) => {
        const header = headerOf(question, index);
        const written = !pending ? freeText(question, index) : '';
        return <div key={header} className="question-block">
          <p>{question.question}</p>
          {question.multiSelect && pending && <p className="caption">{text.questionMultiSelect}</p>}
          {(question.options ?? []).map(option => {
            if (typeof option.label !== 'string') return null;
            const isOn = selected(header, option.label, question.multiSelect);
            const fade = !pending && (expired || cancelled || declined || Boolean(settledAnswers && !isOn) || (!settledAnswers && card.status === 'approved' && !isOn));
            return <button
              key={option.label}
              type="button"
              className={`option${isOn ? ' selected' : ''}${fade ? ' faded' : ''}`}
              data-testid="question-option"
              data-selected={isOn || undefined}
              data-faded={fade || undefined}
              disabled={disabled || !pending}
              onClick={() => { setOtherText(current => ({ ...current, [header]: '' })); toggle(header, option.label!, question.multiSelect); }}
            >
              <span>{option.label}</span>
              {isOn && !pending && <span className="option-check" data-testid="question-choice-check" aria-hidden="true">✓</span>}
              {option.recommended && <small>{text.questionRecommended}</small>}
              {option.description && <small>{option.description}</small>}
            </button>;
          })}
          {pending ? <label className="question-other">{text.questionOther}
            <input
              value={otherText[header] ?? ''}
              disabled={disabled}
              placeholder={text.questionOtherPlaceholder}
              onChange={event => {
                const value = event.target.value;
                setOtherText(current => ({ ...current, [header]: value }));
                if (!question.multiSelect && value.trim()) {
                  setAnswers(current => ({ ...current, [header]: '' }));
                }
              }}
            />
          </label> : written ? <p className="question-your-answer" data-testid="question-your-answer">{text.questionYourAnswer}{written}</p> : null}
        </div>;
      })}
    </div>
    {pending ? <div className="approval-actions">
      <button disabled={disabled} onClick={() => void skip()}>{text.questionSkip}</button>
      <button disabled={disabled || !readable || !answered} onClick={submit}>{text.questionSubmit}</button>
    </div> : resultCopy ? <p role="status" data-testid="question-outcome" data-status={String(card.status)}>{resultCopy}</p> : null}
  </section>;
}

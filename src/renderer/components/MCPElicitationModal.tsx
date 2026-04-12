// ============================================================================
// MCPElicitationModal - Display MCP server elicitation requests
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { Server, Check, X } from 'lucide-react';
import type { MCPElicitationRequest, MCPElicitationResponse, ElicitationFieldSchema } from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import { Modal, ModalFooter } from './primitives/Modal';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('MCPElicitationModal');

interface Props {
  request: MCPElicitationRequest;
  onClose: () => void;
}

/**
 * Render a single form field based on its schema type
 */
function ElicitationField({
  name,
  schema,
  value,
  onChange,
  isRequired,
}: {
  name: string;
  schema: ElicitationFieldSchema;
  value: string | number | boolean | undefined;
  onChange: (name: string, value: string | number | boolean) => void;
  isRequired: boolean;
}) {
  const label = schema.title || name;

  if (schema.type === 'boolean') {
    return (
      <label className="flex items-center gap-3 p-3 rounded-lg border border-zinc-700 hover:border-zinc-600 cursor-pointer">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(name, e.target.checked)}
          className="w-4 h-4 rounded border-zinc-600 text-blue-500 focus:ring-blue-500 bg-zinc-800"
        />
        <div className="flex-1">
          <span className="text-sm font-medium text-zinc-200">{label}</span>
          {isRequired && <span className="text-red-400 ml-1">*</span>}
          {schema.description && (
            <p className="text-xs text-zinc-400 mt-0.5">{schema.description}</p>
          )}
        </div>
      </label>
    );
  }

  if (schema.enum && schema.enum.length > 0) {
    return (
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-200">
          {label}
          {isRequired && <span className="text-red-400 ml-1">*</span>}
        </label>
        {schema.description && (
          <p className="text-xs text-zinc-400">{schema.description}</p>
        )}
        <div className="space-y-1">
          {schema.enum.map((option: string, idx: number) => {
            const displayName = schema.enumNames?.[idx] || option;
            return (
              <button
                key={option}
                onClick={() => onChange(name, option)}
                className={`w-full p-2 rounded-lg border text-left text-sm transition-all ${
                  value === option
                    ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50'
                    : 'border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800'
                }`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${
                      value === option
                        ? 'border-blue-500 bg-blue-500'
                        : 'border-zinc-600'
                    }`}
                  >
                    {value === option && <Check className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <span className="text-zinc-200">{displayName}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <div className="space-y-1">
        <label className="text-sm font-medium text-zinc-200">
          {label}
          {isRequired && <span className="text-red-400 ml-1">*</span>}
        </label>
        {schema.description && (
          <p className="text-xs text-zinc-400">{schema.description}</p>
        )}
        <input
          type="number"
          value={value !== undefined ? String(value) : ''}
          placeholder={schema.default !== undefined ? String(schema.default) : ''}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === 'integer' ? 1 : undefined}
          onChange={(e) => {
            const num = schema.type === 'integer'
              ? parseInt(e.target.value, 10)
              : parseFloat(e.target.value);
            if (!isNaN(num)) {
              onChange(name, num);
            }
          }}
          className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
        />
      </div>
    );
  }

  // Default: string input
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-zinc-200">
        {label}
        {isRequired && <span className="text-red-400 ml-1">*</span>}
      </label>
      {schema.description && (
        <p className="text-xs text-zinc-400">{schema.description}</p>
      )}
      <input
        type={schema.format === 'email' ? 'email' : schema.format === 'uri' ? 'url' : 'text'}
        value={value !== undefined ? String(value) : ''}
        placeholder={schema.default !== undefined ? String(schema.default) : ''}
        maxLength={schema.maxLength}
        onChange={(e) => onChange(name, e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-200 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none"
      />
    </div>
  );
}

export const MCPElicitationModal: React.FC<Props> = ({ request, onClose }) => {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});

  // Initialize with defaults
  useEffect(() => {
    const initial: Record<string, string | number | boolean> = {};
    for (const [name, schema] of Object.entries(request.fields) as [string, ElicitationFieldSchema][]) {
      if (schema.default !== undefined) {
        initial[name] = schema.default;
      }
    }
    setValues(initial);
  }, [request]);

  const handleChange = useCallback((name: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  const requiredFields = new Set(request.required || []);

  const canSubmit = (): boolean => {
    for (const name of requiredFields) {
      const val = values[name];
      if (val === undefined || val === '') return false;
    }
    return true;
  };

  const sendResponse = async (action: 'accept' | 'decline' | 'cancel') => {
    const response: MCPElicitationResponse = {
      requestId: request.id,
      action,
      content: action === 'accept' ? values : undefined,
    };

    try {
      await ipcService.invoke(IPC_CHANNELS.MCP_ELICITATION_RESPONSE, response);
      onClose();
    } catch (error) {
      logger.error('Failed to submit elicitation response', error);
    }
  };

  const handleSubmit = () => {
    if (!canSubmit()) return;
    sendResponse('accept');
  };

  const handleDecline = () => {
    sendResponse('decline');
  };

  const fieldEntries = Object.entries(request.fields) as [string, ElicitationFieldSchema][];
  const hasFields = fieldEntries.length > 0;

  return (
    <Modal
      isOpen={true}
      onClose={() => sendResponse('cancel')}
      size="lg"
      title="MCP 服务器请求输入"
      headerBgClass="bg-purple-500/10"
      headerIcon={<Server className="w-5 h-5 text-purple-400" />}
      footer={
        <ModalFooter
          cancelText="拒绝"
          confirmText={hasFields ? '提交' : '确认'}
          onCancel={handleDecline}
          onConfirm={handleSubmit}
          confirmColorClass="bg-purple-500 hover:bg-purple-600"
          confirmDisabled={hasFields && !canSubmit()}
        />
      }
    >
      <div className="space-y-4 max-h-[60vh] overflow-y-auto -mx-6 px-6">
        {/* Server name badge */}
        <div className="flex items-center gap-2">
          <span className="inline-block px-2 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-300">
            {request.serverName}
          </span>
        </div>

        {/* Message */}
        <p className="text-sm text-zinc-200">{request.message}</p>

        {/* Form fields */}
        {hasFields && (
          <div className="space-y-3">
            {fieldEntries.map(([name, schema]) => (
              <ElicitationField
                key={name}
                name={name}
                schema={schema}
                value={values[name]}
                onChange={handleChange}
                isRequired={requiredFields.has(name)}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
};

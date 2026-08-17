import { useState } from 'react';
import type { PermissionKind } from '../../shared/types';

export interface PermissionRequest {
  requestId: string;
  permission: PermissionKind;
  origin: string;
}

interface Props {
  request: PermissionRequest;
  onRespond: (allow: boolean, remember: boolean) => void;
}

/** Plain-language description of what is actually being asked for. */
const DESCRIPTIONS: Record<PermissionKind, { title: string; detail: string }> = {
  notifications: {
    title: 'show notifications',
    detail: 'The site could show system notifications even when you are not looking at it.',
  },
  geolocation: {
    title: 'know your location',
    detail: 'The site would receive your approximate physical location.',
  },
  camera: { title: 'use your camera', detail: 'The site would be able to see through your camera.' },
  microphone: { title: 'use your microphone', detail: 'The site would be able to hear your microphone.' },
  midi: { title: 'use MIDI devices', detail: 'The site would be able to talk to connected MIDI hardware.' },
  'clipboard-read': {
    title: 'read your clipboard',
    detail: 'The site could read whatever you have copied, which may include passwords.',
  },
  'display-capture': {
    title: 'record your screen',
    detail: 'The site would be able to see the contents of your screen or a window.',
  },
};

export default function PermissionPrompt({ request, onRespond }: Props) {
  const [remember, setRemember] = useState(false);
  const info = DESCRIPTIONS[request.permission] ?? {
    title: `use ${request.permission}`,
    detail: 'This site is requesting a browser capability.',
  };

  return (
    <div className="dialog-overlay">
      <div className="dialog permission-dialog" role="dialog" aria-label="Permission request">
        <h2>Allow this site to {info.title}?</h2>

        <div className="permission-origin">{request.origin}</div>
        <p className="permission-detail">{info.detail}</p>

        <label className="checkbox-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this choice for <strong>{request.permission}</strong> on every site
        </label>

        <p className="settings-note">
          Nothing is granted unless you choose Allow. Closing this without answering denies the request.
        </p>

        <div className="dialog-actions">
          <button onClick={() => onRespond(false, remember)}>Block</button>
          <button className="primary" onClick={() => onRespond(true, remember)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

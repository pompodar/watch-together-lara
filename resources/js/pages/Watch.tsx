import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { debounce } from 'lodash';
import { Play, Pause, Users, Film, RefreshCw, Video, VideoOff, Mic, MicOff } from 'lucide-react';
import AppLayout from '@/layouts/app-layout';
import { Head } from '@inertiajs/react';
import { type BreadcrumbItem } from '@/types';

// --- Constants ---
const COMPONENT_NAME = "Watch";
const LOG_PREFIX = `[${COMPONENT_NAME}]`;

// Interface definitions
interface PeerConnectionEntry {
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  sourceId: string; // The ID of the remote peer
}

interface Room {
  name: string;
  youtube_video_id: string;
}

interface SyncEvent {
  payload: { event: 'play' | 'pause' | 'seek'; time?: number };
  source?: string;
}

type SignalData = RTCSessionDescriptionInit | RTCIceCandidateInit | RTCIceCandidate;

interface PeerSignal {
  type: 'offer' | 'answer' | 'ice-candidate';
  data: SignalData;
  source: string; // ID of the sender
  target: string; // ID of the recipient
}

declare global {
  interface Window {
    Pusher: typeof Pusher;
    Echo: Echo<any>;
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

// WebRTC configuration
const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

export default function Watch({ room }: { room: Room }) {
  console.log(`${LOG_PREFIX} Component Rendering/Re-rendering. Room:`, room?.name);
  const breadcrumbs: BreadcrumbItem[] = [
    { title: `Room: ${room.name}`, href: `/rooms/${room.name}` },
  ];

  // --- State & Refs ---
  const [videoId, setVideoId] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncSource] = useState(() => {
       const id = `client-${Math.random().toString(36).substring(2, 9)}`;
       console.log(`${LOG_PREFIX} Generated syncSource ID: ${id}`);
       return id;
  });
  const [status, setStatus] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  const [usersStartedCount, setUsersStartedCount] = useState(0);
  const [userList, setUserList] = useState<string[]>([]);
  const [seekTime, setSeekTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Video chat state
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const peerConnections = useRef<Record<string, PeerConnectionEntry>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream | null>>({});
  const [videoChatVisible, setVideoChatVisible] = useState(true);
  const isFirstMediaCheckRef = useRef(false); // Ref to track if initiating connections

  const usersInRoom = userList.length;
  const allUsersStarted = usersInRoom > 0 && usersStartedCount >= usersInRoom;

  const playerContainerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const apiLoadedRef = useRef(false);
  const pollerRef = useRef<number | null>(null);
  const echoRef = useRef<Echo<any> | null>(null);

  // --- Utility Functions ---

  // Debounced sync for seek only
  const sendSyncEvent = useRef(
    debounce((event: 'play' | 'pause' | 'seek', time?: number) => {
      if (!syncEnabled || !echoRef.current) return;
      console.log(`${LOG_PREFIX} SYNC SEND [${event}]${time !== undefined ? `: ${time.toFixed(2)}` : ''} from ${syncSource}`);
      axios.post(`/api/rooms/${room.name}/sync`, { event, time, source: syncSource })
         .catch(err => console.error(`${LOG_PREFIX} Sync send failed for event ${event}:`, err));
    }, 300)
  ).current;

  // Polling slider
  const startPolling = useCallback(() => {
    if (pollerRef.current == null) {
        console.log(`${LOG_PREFIX} Starting player time polling.`);
        pollerRef.current = window.setInterval(() => {
            if (playerRef.current?.getCurrentTime) {
                try { const t = playerRef.current.getCurrentTime(); setSeekTime(p => Math.abs(t - p) > 0.25 ? t : p); }
                catch (e) { console.error(`${LOG_PREFIX} Poll err:`, e); stopPolling(); }
            }
        }, 250);
    }
  }, []); // No deps needed

  const stopPolling = useCallback(() => {
    if (pollerRef.current !== null) {
        console.log(`${LOG_PREFIX} Stopping player time polling.`);
        clearInterval(pollerRef.current);
        pollerRef.current = null;
    }
  }, []);


  // --- WebRTC Core Logic ---

   const closePeerConnection = useCallback((peerId: string) => {
       const pcEntry = peerConnections.current[peerId];
       if (pcEntry) {
           console.log(`${LOG_PREFIX} Closing peer connection with ${peerId}`);
           const pc = pcEntry.connection;
           pc.onicecandidate = pc.ontrack = pc.onnegotiationneeded = pc.oniceconnectionstatechange = pc.onconnectionstatechange = pc.onsignalingstatechange = null;
           pc.close(); delete peerConnections.current[peerId];
           setRemoteStreams(prev => { if (!prev[peerId]) return prev; const n = { ...prev }; delete n[peerId]; return n; });
           console.log(`${LOG_PREFIX} PC ${peerId} closed.`);
       }
   }, []);

  const sendSignal = useCallback((signal: PeerSignal) => {
    console.log(`${LOG_PREFIX} SIGNAL SEND [${signal.type}] from ${signal.source} to ${signal.target}`);
    if (!echoRef.current) { console.error(`${LOG_PREFIX} No Echo for sendSignal.`); return; }
    axios.post(`/api/rooms/${room.name}/webrtc-signal`, signal)
      .catch(err => { console.error(`${LOG_PREFIX} Signal send fail [${signal.type}] to ${signal.target}:`, err); setError(`Signal fail: ${err.message}`); });
  }, [room.name]);

  const createPeerConnection = useCallback(async (targetId: string, initiator: boolean): Promise<RTCPeerConnection | null> => {
      const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${targetId})`;
      if (targetId === syncSource) { console.warn(`${logPcPrefix} Self conn reject.`); return null; }
      if (peerConnections.current[targetId]) { console.log(`${logPcPrefix} Already exists.`); return peerConnections.current[targetId].connection; }
      console.log(`${logPcPrefix} Creating new. Init: ${initiator}`);
      let pc: RTCPeerConnection;
      try { pc = new RTCPeerConnection(rtcConfig); }
      catch (e) { console.error(`${logPcPrefix} Creation fail:`, e); setError(`PC Create fail: ${e.message}`); return null; }
      peerConnections.current[targetId] = { connection: pc, stream: null, sourceId: targetId };
      console.log(`${logPcPrefix} Stored ref.`);

      pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ type: 'ice-candidate', data: e.candidate.toJSON(), source: syncSource, target: targetId }); else console.log(`${logPcPrefix} ICE gather complete.`); };
      pc.oniceconnectionstatechange = () => {
          console.log(`${logPcPrefix} ICE state: ${pc.iceConnectionState}`);
          if (pc.iceConnectionState === 'failed') { setError(`ICE fail ${targetId.substring(7,12)}`); console.warn(`${logPcPrefix} ICE fail. Restart?`); if (pc.restartIce) try {pc.restartIce();} catch(e){closePeerConnection(targetId);} else closePeerConnection(targetId); }
          else if (pc.iceConnectionState === 'closed') closePeerConnection(targetId);
          else if (pc.iceConnectionState === 'disconnected') console.warn(`${logPcPrefix} ICE Disconnected.`);
      };
      pc.onconnectionstatechange = () => {
          console.log(`${logPcPrefix} Conn state: ${pc.connectionState}`);
           switch (pc.connectionState) {
             case 'connecting': setStatus(`Conn ${targetId.substring(7, 12)}...`); break;
             case 'connected': setStatus(`OK ${targetId.substring(7, 12)}`); break;
             case 'failed': setError(`Conn Fail ${targetId.substring(7, 12)}`); console.error(`${logPcPrefix} Conn Fail.`); closePeerConnection(targetId); break;
             case 'disconnected': setStatus(`Lost ${targetId.substring(7, 12)}`); break;
             case 'closed': setStatus(`Closed ${targetId.substring(7, 12)}`); closePeerConnection(targetId); break;
           }
      };
       pc.onsignalingstatechange = () => { console.log(`${logPcPrefix} Signal state: ${pc.signalingState}`); };
      pc.ontrack = (event) => {
          console.log(`${logPcPrefix} ONTRACK! Streams: ${event.streams.length}`, event.track.kind);
          if (event.streams?.[0]) {
              const remoteStream = event.streams[0];
              console.log(`${logPcPrefix} Got remote stream ${remoteStream.id}, Tracks: ${remoteStream.getTracks().length}, Active: ${remoteStream.active}`);
              if (peerConnections.current[targetId]) peerConnections.current[targetId].stream = remoteStream;
              setRemoteStreams(prev => { if (prev[targetId]?.id === remoteStream.id) return prev; console.log(`${logPcPrefix} Updating remote stream state.`); return { ...prev, [targetId]: remoteStream }; });
          } else console.warn(`${logPcPrefix} ONTRACK no stream[0].`);
      };
      pc.onnegotiationneeded = async () => {
          console.log(`${logPcPrefix} Negotiation needed. Signal: ${pc.signalingState}`);
          if (pc.signalingState !== 'stable') { console.warn(`${logPcPrefix} Neg need but not stable (${pc.signalingState}). Abort.`); return; }
          try {
              console.log(`${logPcPrefix} Creating neg offer...`); const offer = await pc.createOffer();
              if (pc.signalingState !== 'stable') { console.warn(`${logPcPrefix} Not stable before setLocalDesc neg. Abort.`); return; }
              console.log(`${logPcPrefix} Setting neg local desc.`); await pc.setLocalDescription(offer);
              console.log(`${logPcPrefix} Sending neg offer.`); sendSignal({ type: 'offer', data: pc.localDescription!.toJSON(), source: syncSource, target: targetId });
          } catch (err) { console.error(`${logPcPrefix} Neg offer fail:`, err); setError(`Neg Err: ${err.message}`); closePeerConnection(targetId); }
      };
      if (localStream) {
          console.log(`${logPcPrefix} Adding ${localStream.getTracks().length} initial tracks.`);
          localStream.getTracks().forEach(track => { try { pc.addTrack(track, localStream); } catch (e) { console.error(`${logPcPrefix} Add initial track ${track.kind} fail:`, e); }});
      } else console.log(`${logPcPrefix} No initial stream.`);
      console.log(`${logPcPrefix} Setup complete.`); return pc;
  }, [localStream, sendSignal, syncSource, closePeerConnection, rtcConfig]); // Added rtcConfig dep

  const handleWebRTCSignal = useCallback(async (signal: PeerSignal) => {
      const { type, data, source: peerId, target } = signal;
      const logSigPrefix = `${LOG_PREFIX} SIGNAL RECV [${type}] from ${peerId} to ${target}`;
      if (target !== syncSource || peerId === syncSource) return;
      console.log(`${logSigPrefix}`);
      const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${peerId})`;
      let pcEntry = peerConnections.current[peerId]; let pc = pcEntry?.connection;

      data.sdp += '\n';

      try {
          switch (type) {
              case 'offer': {
                  console.log(`${logSigPrefix} Processing...`); const offer = data as RTCSessionDescriptionInit;
                  if (!pc) { console.log(`${logPcPrefix} Creating conn for offer.`); pc = await createPeerConnection(peerId, false); if (!pc) return; pcEntry = peerConnections.current[peerId]; } else console.log(`${logPcPrefix} Existing conn. State: ${pc.signalingState}`);
                  const amIPolite = syncSource < peerId; const collision = pc.signalingState === 'have-local-offer';
                  if (collision && !amIPolite) { console.warn(`${logPcPrefix} Offer collision, impolite ignore.`); return; }
                  console.log(`${logPcPrefix} Setting remote desc (offer).`);
                  try { await pc.setRemoteDescription(new RTCSessionDescription(offer)); console.log(`${logPcPrefix} Remote desc (offer) OK.`); }
                  catch (e) { console.error(`${logPcPrefix} Set remote desc (offer) ERR:`, e); if (collision && amIPolite) { console.log(`${logPcPrefix} Polite rollback.`); await pc.setLocalDescription({ type: 'rollback' }); console.log(`${logPcPrefix} Retrying set remote desc.`); await pc.setRemoteDescription(new RTCSessionDescription(offer)); console.log(`${logPcPrefix} Retry OK.`); } else throw e; }
                   if (localStream && pcEntry) { console.log(`${logPcPrefix} Checking local tracks pre-answer.`); localStream.getTracks().forEach(track => { if (!pc!.getSenders().find(s => s.track === track)) try { pc!.addTrack(track, localStream); } catch (e) {} }); }
                  console.log(`${logPcPrefix} Creating answer...`); const answer = await pc.createAnswer();
                  console.log(`${logPcPrefix} Setting local desc (answer).`); await pc.setLocalDescription(answer);
                  console.log(`${logPcPrefix} Sending answer.`); sendSignal({ type: 'answer', data: pc.localDescription!.toJSON(), source: syncSource, target: peerId }); break;
               }
               case 'answer': {
                   console.log(`${logSigPrefix} Processing...`); if (!pc) { console.error(`${logPcPrefix} Answer no PC.`); return; } const answer = data as RTCSessionDescriptionInit;
                    if (pc.signalingState !== 'have-local-offer') { console.warn(`${logPcPrefix} Answer unexpected state: ${pc.signalingState}.`); return; }
                   console.log(`${logPcPrefix} Setting remote desc (answer).`);
                   try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); console.log(`${logPcPrefix} Remote desc (answer) OK.`); }
                   catch (e) { console.error(`${logPcPrefix} Set remote desc (answer) ERR:`, e); setError(`Answer ERR ${peerId.substring(7,12)}: ${e.message}`); closePeerConnection(peerId); } break;
               }
               case 'ice-candidate': {
                   if (!pc) { /* console.warn(`${logPcPrefix} ICE no PC.`); */ return; } const candidate = data as RTCIceCandidateInit; if (!candidate?.candidate) return;
                   try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) { if (pc.signalingState !== 'closed') console.warn(`${logPcPrefix} Add ICE ERR:`, err); } break;
               }
           }
       } catch (err) { console.error(`${logPcPrefix} Signal handle ERR [${type}]:`, err); setError(`Signal ${type} ERR: ${err.message}`); if (peerId && pc) { console.error(`${logPcPrefix} Closing conn due to signal err.`); closePeerConnection(peerId); } }
   }, [syncSource, createPeerConnection, sendSignal, localStream, closePeerConnection]);


  // --- React Effects ---

  useEffect(() => { /* Video ID extraction - unchanged */
    console.log(`${LOG_PREFIX} Effect: Extracting Video ID from`, room.youtube_video_id);
    try { const u = new URL(room.youtube_video_id); const v = u.searchParams.get('v'); if (v) setVideoId(v); else setVideoId(room.youtube_video_id); }
    catch (e) { console.warn(`${LOG_PREFIX} URL parse fail, using raw: ${room.youtube_video_id}`); setVideoId(room.youtube_video_id); }
  }, [room.youtube_video_id]);

  useEffect(() => { /* YouTube API load - unchanged */
     console.log(`${LOG_PREFIX} Effect: YT API Load check. Loaded: ${apiLoadedRef.current}`);
     if (apiLoadedRef.current || window.YT?.Player) { if (!apiLoadedRef.current) apiLoadedRef.current = true; setStatus('YouTube API ready'); return; }
     console.log(`${LOG_PREFIX} Injecting YT API script.`); const tag = document.createElement('script'); tag.src = 'https://www.youtube.com/iframe_api'; tag.async = true; document.body.appendChild(tag);
     window.onYouTubeIframeAPIReady = () => { console.log(`${LOG_PREFIX} window.onYouTubeIframeAPIReady Fired!`); apiLoadedRef.current = true; setStatus('YouTube API ready'); };
     return () => { window.onYouTubeIframeAPIReady = () => {}; }
  }, []);

  useEffect(() => { /* Player initialization - unchanged */
    console.log(`${LOG_PREFIX} Effect: Player Init Check. API: ${apiLoadedRef.current}, Vid: ${!!videoId}, Start: ${start}, AllStart: ${allUsersStarted}, Cont: ${!!playerContainerRef.current}, Player: ${!!playerRef.current}`);
    if (!apiLoadedRef.current || !videoId || !start || !allUsersStarted || !playerContainerRef.current) { if (playerRef.current && (!start || !allUsersStarted)) { console.log(`${LOG_PREFIX} Destroying player.`); try { playerRef.current.destroy(); } catch(e){} playerRef.current = null; stopPolling(); setDuration(0); setSeekTime(0); } return; }
    if (playerRef.current) { console.log(`${LOG_PREFIX} Player already init.`); return; }
    setStatus('Initializing YouTube player...'); console.log(`${LOG_PREFIX} YT Player Init: Creating for ${videoId}`);
    try { playerRef.current = new window.YT.Player(playerContainerRef.current, { videoId, playerVars: { autoplay: 0, controls: 0, rel: 0, modestbranding: 1, disablekb: 1, fs: 0, origin: window.location.origin }, events: { onReady: (e: any) => { console.log(`${LOG_PREFIX} YT Ready`); setStatus('Player ready'); try { const d = e.target.getDuration(); console.log(`${LOG_PREFIX} Duration: ${d}`); setDuration(d); } catch(err) {} }, onStateChange: (e: any) => { const s = Object.entries(window.YT.PlayerState).find(([_,v])=>v===e.data)?.[0]??'UNK'; console.log(`${LOG_PREFIX} YT State: ${e.data} (${s})`); const t=playerRef.current?.getCurrentTime?.(); if (syncEnabled) { if (e.data === 1) { sendSyncEvent('play'); startPolling(); } else if (e.data === 2) { sendSyncEvent('pause'); stopPolling(); } else if (e.data === 3 && t!==undefined) { sendSyncEvent.flush(); sendSyncEvent('seek', t); stopPolling(); } else if (e.data === 0) { stopPolling(); sendSyncEvent('pause'); } else if (e.data === 5) { stopPolling(); try{setDuration(playerRef.current.getDuration());}catch(err){} } else stopPolling(); } else { if(e.data===1) startPolling(); else stopPolling(); } }, onError: (e: any) => { console.error(`${LOG_PREFIX} YT Error ${e.data}`); setError(`YT Err ${e.data}`); stopPolling(); } }, }); }
    catch (error) { console.error(`${LOG_PREFIX} YT Create Fail:`, error); setError(`YT Init Fail: ${error.message}`); }
  }, [videoId, start, allUsersStarted, syncEnabled, sendSyncEvent, startPolling, stopPolling]);

  useEffect(() => { /* Echo setup - unchanged */
    if (!room.name || echoRef.current) return;
    console.log(`${LOG_PREFIX} Effect: Echo Setup for ${room.name}`); setStatus('Connecting...'); window.Pusher = Pusher; let echo: Echo<any>;
    try { echo = new Echo({ broadcaster: 'pusher', key: import.meta.env.VITE_PUSHER_APP_KEY, cluster: import.meta.env.VITE_PUSHER_APP_CLUSTER, forceTLS: true }); echoRef.current = echo; setStatus('Connected.'); }
    catch (e) { console.error(`${LOG_PREFIX} Echo Init Fail:`, e); setError(`Connect Fail: ${e.message}`); return; }
    const chans = { s: `public-room.${room.name}`, t: `public-room-users-started.${room.name}`, w: `public-room-webrtc.${room.name}`, j: `public-room-users-joined.${room.name}`, l: `public-room-users-left.${room.name}` }; console.log(`${LOG_PREFIX} Subscribing:`, chans);
    echo.channel(chans.s).listen('.sync', (d: SyncEvent) => { if (d.source === syncSource || !syncEnabled || !playerRef.current) return; const {event, time}=d.payload; try{ const p=playerRef.current; if(!p)return; const cs=p.getPlayerState?.(); const ct=p.getCurrentTime?.()??0; if(event==='play'&&cs!==1)p.playVideo(); else if(event==='pause'&&cs!==2)p.pauseVideo(); else if(event==='seek'&&time!=null&&Math.abs(time-ct)>1.0){p.seekTo(time,true); setSeekTime(time);} }catch(e){} });
    echo.channel(chans.t).listen('.user-started', (d: { source: string, startedCount?: number }) => { console.log(`${LOG_PREFIX} RECV .user-started ${d.source}`); if (d.startedCount !== undefined) setUsersStartedCount(d.startedCount); else setUsersStartedCount(p => p + 1); });
    echo.channel(chans.w).listen('.signal', (e: { signal: PeerSignal }) => { if (e?.signal) handleWebRTCSignal(e.signal); else console.warn(`${LOG_PREFIX} Malformed signal:`, e); });
    echo.channel(chans.j).listen('.user-joined', (d: { source: string, currentUsers?: string[] }) => { console.log(`${LOG_PREFIX} RECV .user-joined ${d.source}`); if (d.currentUsers) setUserList(d.currentUsers); else setUserList(p => p.includes(d.source) ? p : [...p, d.source]); if (d.source !== syncSource && localStream) { console.log(`${LOG_PREFIX} New user ${d.source}, initiating conn.`); createPeerConnection(d.source, true); } });
    echo.channel(chans.l).listen('.user-left', (d: { source: string, currentUsers?: string[] }) => { console.log(`${LOG_PREFIX} RECV .user-left ${d.source}`); if (d.source !== syncSource) { closePeerConnection(d.source); if (d.currentUsers) setUserList(d.currentUsers); else setUserList(p => p.filter(id => id !== d.source)); } });
    console.log(`${LOG_PREFIX} Announcing self join (${syncSource}).`); axios.post(`/api/rooms/${room.name}/user-joined`, { source: syncSource }) .then(r => { console.log(`${LOG_PREFIX} Join announced. State:`, r.data); if (r.data?.currentUsers) setUserList(r.data.currentUsers); if (r.data?.startedCount !== undefined) setUsersStartedCount(r.data.startedCount); }).catch(err => { console.error(`${LOG_PREFIX} Join announce fail:`, err); setError(`Join fail: ${err.message}`); }); console.log(`${LOG_PREFIX} Echo setup complete.`);
  }, [room.name, syncSource, syncEnabled, handleWebRTCSignal, createPeerConnection, localStream, closePeerConnection]); // Added deps

  useEffect(() => { /* Main Cleanup - unchanged */
    console.log(`${LOG_PREFIX} Effect: Mount setup complete.`);
    return () => {
      console.warn(`${LOG_PREFIX} Effect: Cleanup Running! Component unmounting.`);
      console.log(`${LOG_PREFIX} Cleanup: Stopping polling.`); stopPolling();
      if (playerRef.current) { console.log(`${LOG_PREFIX} Cleanup: Destroying player.`); try { playerRef.current.destroy(); } catch (e) {} playerRef.current = null; }
      if (localStream) { console.log(`${LOG_PREFIX} Cleanup: Stopping local stream.`); localStream.getTracks().forEach(track => track.stop()); /* setLocalStream(null); */ } // State cleared by unmount
      console.log(`${LOG_PREFIX} Cleanup: Closing peers (${Object.keys(peerConnections.current).length}).`); Object.keys(peerConnections.current).forEach(closePeerConnection); peerConnections.current = {}; /* setRemoteStreams({}); */ // State cleared
      if (echoRef.current) {
          console.log(`${LOG_PREFIX} Cleanup: Leaving Echo channels & disconnecting.`); const echo = echoRef.current; const rn = room.name;
          [`public-room.${rn}`, `public-room-users-started.${rn}`, `public-room-webrtc.${rn}`, `public-room-users-joined.${rn}`, `public-room-users-left.${rn}`].forEach(c => { /* console.log(`${LOG_PREFIX} Cleanup: Leaving ${c}`); */ echo.leave(c); });
          echo.disconnect(); console.log(`${LOG_PREFIX} Cleanup: Echo disconnected.`); echoRef.current = null;
      }
       if (room.name && syncSource) { console.log(`${LOG_PREFIX} Cleanup: Sending user-left.`); axios.post(`/api/rooms/${room.name}/user-left`, { source: syncSource }).catch(err => console.log(`${LOG_PREFIX} Cleanup user-left failed:`, err)); }
       console.warn(`${LOG_PREFIX} Effect: Cleanup Complete.`);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePeerConnection, room.name, stopPolling, syncSource]); // Add only necessary deps


  // --- NEW EFFECTS FOR DECOUPLING ---

    // Effect to update local video preview when localStream changes
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: Updating local video srcObject. Stream ID: ${localStream?.id}, Active: ${localStream?.active}`);
        if (localVideoRef.current) {
            const videoElement = localVideoRef.current;
            if (localStream && localStream.active) {
                console.log(`${LOG_PREFIX} Effect: Assigning stream ${localStream.id} to local video element.`);
                 // Check if srcObject is already set to this stream
                 if (videoElement.srcObject !== localStream) {
                    videoElement.srcObject = localStream;
                    videoElement.play().catch(e => console.warn(`${LOG_PREFIX} Local preview autoplay error: ${e.message}`)); // Attempt play
                 } else {
                    console.log(`${LOG_PREFIX} Effect: srcObject already set to this stream.`);
                 }
            } else {
                console.log(`${LOG_PREFIX} Effect: Clearing local video element srcObject.`);
                videoElement.srcObject = null;
            }
        }
    }, [localStream]); // Run whenever localStream state changes


    // Effect to handle peer connection updates when media is enabled/disabled or user list changes
    useEffect(() => {
        const logEffectPrefix = `${LOG_PREFIX} Effect (Peer Update):`;
        console.log(`${logEffectPrefix} Running. Cam: ${cameraEnabled}, Mic: ${micEnabled}, Stream: ${localStream?.id}, Users: ${userList.length}`);

        // Determine if media is currently active
        const mediaActive = (cameraEnabled || micEnabled) && localStream?.active;

        if (!mediaActive) {
            console.log(`${logEffectPrefix} Media not active or no stream. Skipping peer updates.`);
            // Optional: Cleanup - If media just turned off, ensure tracks are removed from peers.
            // This might be redundant if toggleCamera/Mic already handles removeTrack via renegotiation.
            // Consider removing tracks *here* if toggle functions only stop/remove from localStream state.
            return;
        }

        // --- Media is Active ---
        console.log(`${logEffectPrefix} Media active with stream ${localStream!.id}. Processing peers.`);
        const videoTrack = localStream!.getVideoTracks()[0] || null; // Ensure null if missing
        const audioTrack = localStream!.getAudioTracks()[0] || null; // Ensure null if missing
        const currentPeers = peerConnections.current;
        const currentPeerIds = Object.keys(currentPeers);

        // Check if this effect run should trigger initiating connections to new peers
        // We use a ref to only do this check *once* when media first becomes active
        let initiateConnections = false;
        if (!isFirstMediaCheckRef.current) {
            console.log(`${logEffectPrefix} First media check running.`);
            isFirstMediaCheckRef.current = true; // Mark check as done for this active media session
            initiateConnections = true;
        }

        let trackUpdateError: Error | null = null;
        let createConnectionError: Error | null = null;

        // --- 1. Update existing connections ---
        console.log(`${logEffectPrefix} Updating tracks for ${currentPeerIds.length} existing connections.`);
        currentPeerIds.forEach(peerId => {
            if (trackUpdateError) return; // Stop processing if error occurred
            const { connection } = currentPeers[peerId];
            const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${peerId})`;
            try {
                // --- Video Track ---
                const videoSender = connection.getSenders().find(s => s.track?.kind === 'video');
                if (videoTrack && videoSender) { // Have track, have sender
                    if (videoSender.track !== videoTrack) { console.log(`${logPcPrefix} Replacing video track.`); videoSender.replaceTrack(videoTrack); }
                } else if (videoTrack && !videoSender) { // Have track, no sender
                    console.log(`${logPcPrefix} Adding video track sender.`); connection.addTrack(videoTrack, localStream!);
                } else if (!videoTrack && videoSender) { // No track, have sender
                    console.log(`${logPcPrefix} Removing video track sender.`); connection.removeTrack(videoSender);
                }

                // --- Audio Track ---
                const audioSender = connection.getSenders().find(s => s.track?.kind === 'audio');
                 if (audioTrack && audioSender) { // Have track, have sender
                     if (audioSender.track !== audioTrack) { console.log(`${logPcPrefix} Replacing audio track.`); audioSender.replaceTrack(audioTrack); }
                 } else if (audioTrack && !audioSender) { // Have track, no sender
                     console.log(`${logPcPrefix} Adding audio track sender.`); connection.addTrack(audioTrack, localStream!);
                 } else if (!audioTrack && audioSender) { // No track, have sender
                     console.log(`${logPcPrefix} Removing audio track sender.`); connection.removeTrack(audioSender);
                 }

            } catch (e) {
                console.error(`!!! ${logPcPrefix} CRITICAL ERROR updating tracks in Effect:`, e);
                trackUpdateError = e instanceof Error ? e : new Error(String(e));
            }
        }); // End loop peers
        console.log(`${logEffectPrefix} Finished updating existing connections.`);

        // --- 2. Initiate connections to users who joined before media was active ---
        if (initiateConnections) {
            console.log(`${logEffectPrefix} Initiating connections for users present before media activation...`);
             // Use Promise.allSettled to attempt all connections
            Promise.allSettled(
                userList.map(async (peerId) => {
                    if (peerId !== syncSource && !currentPeers[peerId]) { // Connect if not self and no existing connection
                        try {
                            console.log(`${logEffectPrefix} Initiating connection to ${peerId}`);
                            await createPeerConnection(peerId, true); // true = initiator
                        } catch (e) {
                            console.error(`!!! ${logEffectPrefix} CRITICAL ERROR initiating connection to ${peerId}:`, e);
                            if (!createConnectionError) createConnectionError = e instanceof Error ? e : new Error(String(e));
                        }
                    }
                })
            ).then((results) => {
                console.log(`${logEffectPrefix} Finished initiating connections attempt.`);
                const failed = results.filter(r => r.status === 'rejected');
                if (failed.length > 0 || createConnectionError) {
                     setError(`WebRTC Init Error: Failed ${failed.length} connections. ${createConnectionError?.message ?? ''}`);
                }
            });
        } // End if initiateConnections

        // Report errors encountered during track updates
        if (trackUpdateError) {
             setError(`WebRTC Update Error: Failed track update. ${trackUpdateError.message}`);
        }

        // Cleanup function for this effect: Reset the 'first check' flag when media becomes inactive
        return () => {
            // This cleanup runs when dependencies change OR component unmounts
            // We only want to reset the flag if media is *no longer* active
             if (!(cameraEnabled || micEnabled) || !localStream?.active) {
                  console.log(`${logEffectPrefix} Cleanup: Resetting first media check flag.`);
                  isFirstMediaCheckRef.current = false;
             }
        }

    // Ensure all dependencies that influence the logic are included
    }, [localStream, cameraEnabled, micEnabled, userList, createPeerConnection, syncSource]);


  // --- User Actions ---

  const sendUserStarted = () => {
    if (start) return; console.log(`${LOG_PREFIX} Action: Start.`); setStart(true); setStatus("Waiting...");
    axios.post(`/api/rooms/${room.name}/user-started`, { source: syncSource }) .then(() => console.log(`${LOG_PREFIX} Sent user-started.`)) .catch(err => { console.error(`${LOG_PREFIX} Fail start signal:`, err); setError(`Fail start: ${err.message}`); setStart(false); setStatus("Fail start."); }); };
  const play = () => { if (!playerRef.current || !allUsersStarted) return; console.log(`${LOG_PREFIX} Action: Play.`); playerRef.current.playVideo(); };
  const pause = () => { if (!playerRef.current || !allUsersStarted) return; console.log(`${LOG_PREFIX} Action: Pause.`); playerRef.current.pauseVideo(); };
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => { if (!playerRef.current || !allUsersStarted) return; const t = parseFloat(e.target.value); setSeekTime(t); playerRef.current.seekTo(t, true); sendSyncEvent('seek', t); };
  const handleSeekMouseUp = () => { if (syncEnabled && playerRef.current && allUsersStarted) { sendSyncEvent.flush(); const t = playerRef.current.getCurrentTime?.(); if (t !== undefined) sendSyncEvent('seek', t); } };

 // Toggle Camera (Simplified - relies on useEffect for peer updates)
 const toggleCamera = async () => {
     const action = cameraEnabled ? "OFF" : "ON";
     console.log(`${LOG_PREFIX} Action: Toggle Camera ${action}`);

     if (!cameraEnabled) { // --- Turning Camera ON ---
         let videoTrack: MediaStreamTrack | null = null;
         try {
             setStatus('Requesting camera...'); const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: micEnabled }); setStatus('Camera granted.');
             videoTrack = stream.getVideoTracks()[0]; if (!videoTrack) throw new Error("No video track."); console.log(`${LOG_PREFIX} Got video track ${videoTrack.id}`);
             setLocalStream(prev => { const u = prev || new MediaStream(); const e = u.getVideoTracks()[0]; if (e) u.removeTrack(e); u.addTrack(videoTrack!); console.log(`${LOG_PREFIX} Queued stream update ADD video ${videoTrack!.id}`); return u; });
             setCameraEnabled(true); setStatus('Camera enabled.'); // Optimistic status
         } catch (err) { console.error(`${LOG_PREFIX} toggleCamera (ON) ERR:`, err); setError(`Cam Err: ${err.message}`); setStatus('Cam fail.'); setCameraEnabled(false); if (videoTrack?.readyState === 'live') videoTrack.stop(); }
     } else { // --- Turning Camera OFF ---
         try {
             setStatus('Turning cam off...'); setCameraEnabled(false);
             const currentStream = localStream; // Use state directly
             if (currentStream) {
                 const track = currentStream.getVideoTracks()[0];
                 if (track) {
                     console.log(`${LOG_PREFIX} Stopping video track ${track.id}`); track.stop();
                     // Rely on useEffect to handle peer track removal when stream state updates
                     setLocalStream(prev => { if (!prev) return null; const next = new MediaStream(prev.getTracks().filter(t => t !== track)); console.log(`${LOG_PREFIX} Queued stream update REMOVE video ${track.id}`); return next.getTracks().length > 0 ? next : null; });
                 }
             } setStatus('Camera disabled.');
          } catch (err) { console.error(`${LOG_PREFIX} toggleCamera (OFF) ERR:`, err); setError(`Cam disable Err: ${err.message}`); setStatus('Cam disable fail.'); }
     }
 };

  // Toggle Mic (Simplified - relies on useEffect for peer updates)
  const toggleMic = async () => {
      const action = micEnabled ? "OFF" : "ON";
      console.log(`${LOG_PREFIX} Action: Toggle Mic ${action}`);

      if (!micEnabled) { // --- Turning Mic ON ---
          let audioTrack: MediaStreamTrack | null = null;
          try {
              setStatus('Requesting mic...'); const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); setStatus('Mic granted.');
              audioTrack = stream.getAudioTracks()[0]; if (!audioTrack) throw new Error("No audio track."); console.log(`${LOG_PREFIX} Got audio track ${audioTrack.id}`);
              setLocalStream(prev => { const u = prev || new MediaStream(); const e = u.getAudioTracks()[0]; if (e) u.removeTrack(e); u.addTrack(audioTrack!); console.log(`${LOG_PREFIX} Queued stream update ADD audio ${audioTrack!.id}`); return u; });
              setMicEnabled(true); setStatus('Microphone enabled.');
          } catch (err) { console.error(`${LOG_PREFIX} toggleMic (ON) ERR:`, err); setError(`Mic Err: ${err.message}`); setStatus('Mic fail.'); setMicEnabled(false); if (audioTrack?.readyState === 'live') audioTrack.stop(); }
      } else { // --- Turning Mic OFF ---
           try {
               setStatus('Turning mic off...'); setMicEnabled(false);
               const currentStream = localStream;
               if (currentStream) {
                   const track = currentStream.getAudioTracks()[0];
                   if (track) {
                       console.log(`${LOG_PREFIX} Stopping audio track ${track.id}`); track.stop();
                        // Rely on useEffect for peer updates
                       setLocalStream(prev => { if (!prev) return null; const next = new MediaStream(prev.getTracks().filter(t => t !== track)); console.log(`${LOG_PREFIX} Queued stream update REMOVE audio ${track.id}`); return next.getTracks().length > 0 ? next : null; });
                   }
               } setStatus('Microphone disabled.');
           } catch (err) { console.error(`${LOG_PREFIX} toggleMic (OFF) ERR:`, err); setError(`Mic disable Err: ${err.message}`); setStatus('Mic disable fail.'); }
      }
  };


  // --- Render ---
  // console.log(`${LOG_PREFIX} Rendering UI. Status: ${status}, Error: ${!!error}, Users: ${usersInRoom}, Started: ${usersStartedCount}, Cam: ${cameraEnabled}, Mic: ${micEnabled}, #Peers: ${Object.keys(peerConnections.current).length}, #RemoteStreams: ${Object.values(remoteStreams).filter(Boolean).length}`);

  return (
    <AppLayout breadcrumbs={breadcrumbs}>
      <Head title={`Watch: ${room.name}`} />

      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="max-w-6xl w-full bg-white shadow-lg rounded-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b flex-wrap gap-y-2">
            <div className="flex items-center space-x-3 min-w-0">
              <Film className="w-6 h-6 text-indigo-600 flex-shrink-0" />
              <h2 className="text-xl font-semibold text-gray-800 truncate" title={room.name}>Room: {room.name}</h2>
            </div>
            <div className="flex items-center space-x-4 flex-shrink-0">
              <label className="flex items-center space-x-1 text-sm text-gray-600 cursor-pointer" title="Enable/Disable YouTube player synchronization">
                <input type="checkbox" checked={syncEnabled} onChange={() => setSyncEnabled(!syncEnabled)} className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"/>
                <span>Sync</span>
              </label>
               <label className="flex items-center space-x-1 text-sm text-gray-600 cursor-pointer" title="Show/Hide Video Chat Panel">
                 <input type="checkbox" checked={videoChatVisible} onChange={() => setVideoChatVisible(!videoChatVisible)} className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"/>
                 <span>Video Chat</span>
               </label>
              <div className="flex items-center space-x-1" title="Users Started / Total Users">
                 <Users className="w-5 h-5 text-gray-500" /><span className="text-sm font-medium text-gray-700">{usersStartedCount} / {usersInRoom}</span>
              </div>
            </div>
          </div>

          {/* Main Body Flex Container */}
          <div className="flex flex-col md:flex-row">
            {/* Main content Area */}
            <div className={`flex-grow ${videoChatVisible ? 'md:w-3/4' : 'w-full'}`}>
              {/* Video Player or Waiting Area */}
              <div className="relative bg-black aspect-video">
                {allUsersStarted && start ? ( <div ref={playerContainerRef} id="youtube-player-container" className="w-full h-full"/> )
                 : ( <div className="w-full h-full flex items-center justify-center text-white p-4">
                      {!start ? ( <button onClick={sendUserStarted} className="px-8 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-xl transition duration-150 ease-in-out text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black focus:ring-indigo-400"> Join Session & Start </button> )
                       : ( <div className='text-center'> <p className="text-xl mb-2 animate-pulse">Waiting for others...</p> <p className="text-sm">({usersStartedCount} / {usersInRoom} ready)</p> </div> )}
                     </div> )}
              </div>
              {/* Status/Error Bar */}
              {(status || error) && ( <div className="px-6 py-1.5 text-xs border-t text-gray-600 bg-gray-50"> {error ? ( <span className="text-red-600 font-medium">Error: {error}</span> ) : ( <span>Status: {status}</span> )} </div> )}
              {/* Player Controls */}
              {allUsersStarted && start && duration > 0 && (
                <div className="px-6 py-4 border-t bg-gray-50 flex flex-col space-y-3">
                  <div className="flex items-center justify-center space-x-4">
                    <button onClick={play} title="Play" className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500"><Play className="w-5 h-5 text-indigo-700" /></button>
                    <button onClick={pause} title="Pause" className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500"><Pause className="w-5 h-5 text-indigo-700" /></button>
                    <button title="Seek to Start" onClick={() => { setSeekTime(0); playerRef.current?.seekTo(0, true); sendSyncEvent.flush(); sendSyncEvent('seek', 0); }} className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500"><RefreshCw className="w-5 h-5 text-indigo-700" /></button>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-gray-600 w-10 text-right font-mono">{new Date(seekTime * 1000).toISOString().substr(14, 5)}</span>
                    <input type="range" aria-label="Video Seek Bar" min={0} max={duration} step={0.1} value={seekTime} onChange={handleSeekChange} onMouseUp={handleSeekMouseUp} onTouchEnd={handleSeekMouseUp} className="flex-1 h-1.5 rounded-lg appearance-none bg-gray-300 accent-indigo-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"/>
                    <span className="text-xs text-gray-600 w-10 text-left font-mono">{new Date(duration * 1000).toISOString().substr(14, 5)}</span>
                  </div>
                </div> )}
            </div> {/* End Main Content Area */}

            {/* Video Chat Sidebar */}
            {videoChatVisible && (
              <div className="w-full md:w-1/4 border-t md:border-t-0 md:border-l bg-gray-50 flex flex-col" style={{ maxHeight: 'calc(100vh - 100px)', minHeight: '300px' }}>
                {/* Sidebar Header & Controls */}
                <div className="p-4 border-b sticky top-0 bg-gray-50 z-10 flex-shrink-0">
                  <h3 className="font-medium text-gray-700 mb-3 text-center">Video Chat</h3>
                  <div className="flex justify-center space-x-3">
                    <button onClick={toggleCamera} disabled={!navigator.mediaDevices?.getUserMedia} className={`p-2.5 rounded-full transition duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-1 ${ cameraEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200 focus:ring-green-500' : 'bg-gray-200 text-gray-600 hover:bg-gray-300 focus:ring-gray-500' } ${!navigator.mediaDevices?.getUserMedia ? 'opacity-50 cursor-not-allowed' : ''}`} title={cameraEnabled ? "Turn camera off" : "Turn camera on"}> {cameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />} </button>
                    <button onClick={toggleMic} disabled={!navigator.mediaDevices?.getUserMedia} className={`p-2.5 rounded-full transition duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-1 ${ micEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200 focus:ring-green-500' : 'bg-gray-200 text-gray-600 hover:bg-gray-300 focus:ring-gray-500' } ${!navigator.mediaDevices?.getUserMedia ? 'opacity-50 cursor-not-allowed' : ''}`} title={micEnabled ? "Mute microphone" : "Unmute microphone"}> {micEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />} </button>
                  </div>
                </div> {/* End Sidebar Header */}
                {/* Video Previews Container */}
                 <div className="p-2 space-y-3 overflow-y-auto flex-grow">
                     {/* Local Video Preview */}
                     {(cameraEnabled || micEnabled) && localStream?.active && (
                         <div className="mb-2">
                             <p className="text-xs font-medium text-gray-600 mb-1 ml-1 flex items-center"> You <span className="ml-1 px-1.5 py-0.5 text-indigo-700 bg-indigo-100 rounded text-xxs font-bold">LOCAL</span> </p>
                             <div className="aspect-video bg-gray-900 rounded overflow-hidden relative shadow ring-1 ring-indigo-300">
                                 <video ref={localVideoRef} key={localStream.id} autoPlay muted playsInline className="w-full h-full object-cover" onLoadedMetadata={(e) => { e.currentTarget.play().catch(err => console.warn(`${LOG_PREFIX} Local autoplay prevented:`, err))}} onError={(e) => console.error(`${LOG_PREFIX} Local video element error:`, e)}/>
                                  {!micEnabled && ( <div className="absolute top-1 right-1 p-0.5 bg-red-600 rounded-full"><MicOff className="w-3 h-3 text-white" /></div> )}
                             </div>
                         </div>
                     )}
                     {/* Remote Peer Videos */}
                     {Object.entries(remoteStreams).filter(([_, stream]) => stream?.active && stream.getTracks().length > 0).map(([peerId, stream]) => (
                        <div key={peerId}>
                           <p className="text-xs font-medium text-gray-600 mb-1 ml-1 truncate" title={peerId}> Peer <span className='font-mono text-xs'>{peerId.substring(7, 12)}</span> </p>
                            <div className="aspect-video bg-gray-800 rounded overflow-hidden relative shadow">
                                <video key={stream.id} autoPlay playsInline className="w-full h-full object-cover" srcObject={stream} onLoadedMetadata={(e) => { e.currentTarget.play().catch(err => console.warn(`${LOG_PREFIX} Remote autoplay ${peerId.substring(7,12)} prevented:`, err))}} onError={(e) => console.error(`${LOG_PREFIX} Remote video ${peerId.substring(7,12)} error:`, e)}/>
                            </div>
                        </div> ))}
                      {/* Placeholder Messages */}
                      {Object.values(remoteStreams).filter(s => s?.active && s.getTracks().length > 0).length === 0 && (cameraEnabled || micEnabled) && ( <p className='text-xs text-gray-500 text-center mt-4 px-2'>Waiting for others...</p> )}
                      {!(cameraEnabled || micEnabled) && ( <p className='text-xs text-gray-500 text-center mt-4 px-2'>Turn on camera/mic to chat.</p> )}
                 </div> {/* End Video Previews Container */}
              </div> // End Video Chat Sidebar
            )}
          </div> {/* End Main Flex Container */}
        </div> {/* End White Card */}
      </div> {/* End Gray Background */}
    </AppLayout>
  );
}

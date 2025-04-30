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
const DEBOUNCE_SYNC_MS = 300;
const POLLING_INTERVAL_MS = 250;
const SEEK_TOLERANCE_S = 1.0; // How much difference triggers remote seek sync

// --- Type Definitions ---
interface PeerConnectionEntry {
    connection: RTCPeerConnection;
    stream: MediaStream | null;
    sourceId: string; // The ID of the remote peer
}

interface Room {
    name: string;
    youtube_video_id: string;
}

interface SyncPayload {
    event: 'play' | 'pause' | 'seek';
    time ? : number;
}

interface SyncEvent {
    payload: SyncPayload;
    source ? : string;
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
        Echo: Echo < any > ;
        YT: any;
        onYouTubeIframeAPIReady: () => void;
    }
}

// --- WebRTC Configuration ---
const rtcConfig: RTCConfiguration = {
    iceServers: [{
        urls: 'stun:stun.l.google.com:19302'
    }, {
        urls: 'stun:stun1.l.google.com:19302'
    },
        // TODO: Add TURN servers for production environments
        // {
        //   urls: 'turn:your.turn.server.address:port',
        //   username: 'your_turn_username',
        //   credential: 'your_turn_password',
        // },
    ]
};

// ============================================================================
// Watch Component
// ============================================================================
export default function Watch({ room }: { room: Room }) {
    console.log(`${LOG_PREFIX} Component Render. Room:`, room?.name);

    // --- Props Derived State ---
    const breadcrumbs: BreadcrumbItem[] = [
        {
            title: `Room: ${room.name}`,
            href: `/rooms/${room.name}`
        },
    ];

    // Small component specifically for rendering a remote stream
    const RemoteVideoPlayer = ({ stream, peerId }: { stream: MediaStream | null, peerId: string }) => {
        const videoRef = useRef<HTMLVideoElement>(null);
        const logPrefix = `${LOG_PREFIX} RemoteVideo (${peerId.substring(7, 12)}):`;

        useEffect(() => {
            console.log(`${logPrefix} Effect running. Stream ID: ${stream?.id}, Active: ${stream?.active}`);
            const videoElement = videoRef.current;
            if (videoElement) {
                if (stream && stream.active) {
                    // Only assign if different to avoid interrupting playback/reloading
                    if (videoElement.srcObject !== stream) {
                        console.log(`${logPrefix} Assigning stream ${stream.id}`);
                        videoElement.srcObject = stream;
                        // Attempt to play when stream is assigned
                        videoElement.play().catch(e => console.warn(`${logPrefix} Autoplay error: ${e.message}`));
                    } else {
                        console.log(`${logPrefix} srcObject already set.`);
                    }
                } else {
                    // Clear srcObject if stream is null or inactive
                    if (videoElement.srcObject !== null) {
                        console.log(`${logPrefix} Clearing srcObject.`);
                        videoElement.srcObject = null;
                    }
                }
            }
        }, [stream, logPrefix]); // Depend on the stream object and logPrefix (stable)

        // Render the video element, passing the ref, but NOT srcObject prop
        return (
            <video
                ref={videoRef}
                autoPlay // Keep autoplay attribute
                playsInline
                className="w-full h-full object-cover"
                onLoadedMetadata={(e) => { console.log(`${logPrefix} Metadata loaded.`); }}
                onError={(e) => console.error(`${logPrefix} Video Element error:`, e)}
                // Do NOT add srcObject={stream} here!
            />
        );
    };

    // --- State ---
    const [videoId, setVideoId] = useState('');
    const [syncEnabled, setSyncEnabled] = useState(true);
    const [syncSource] = useState(() => {
        const id = `client-${Math.random().toString(36).substring(2, 9)}`;
        console.log(`${LOG_PREFIX} Generated syncSource ID: ${id}`);
        return id;
    });
    const [status, setStatus] = useState('Initializing...');
    const [error, setError] = useState < string | null > (null);
    const [start, setStart] = useState(false); // User clicked 'Start'
    const [usersStartedCount, setUsersStartedCount] = useState(0);
    const [userList, setUserList] = useState < string[] > ([]); // List of client IDs in room
    const [seekTime, setSeekTime] = useState(0); // Current player time for UI
    const [duration, setDuration] = useState(0); // Video duration

    // Video Chat State
    const [cameraEnabled, setCameraEnabled] = useState(false);
    const [micEnabled, setMicEnabled] = useState(false);
    const [localStream, setLocalStream] = useState < MediaStream | null > (null);
    const [remoteStreams, setRemoteStreams] = useState < Record < string, MediaStream | null >> ({});
    const [videoChatVisible, setVideoChatVisible] = useState(true);

    // --- Refs ---
    const playerContainerRef = useRef < HTMLDivElement > (null);
    const playerRef = useRef < any > (null); // YouTube Player instance
    const localVideoRef = useRef < HTMLVideoElement > (null); // Local video preview element
    const peerConnections = useRef < Record < string, PeerConnectionEntry >> ({}); // Stores active RTCPeerConnection objects
    const apiLoadedRef = useRef(false); // YouTube API loaded flag
    const pollerRef = useRef < number | null > (null); // Interval ID for player time polling
    const echoRef = useRef < Echo < any > | null > (null); // Laravel Echo instance
    const isFirstMediaCheckRef = useRef(false); // Ref to track if initiating connections effect ran

    // --- Derived State ---
    const usersInRoom = userList.length;
    const allUsersStarted = usersInRoom > 0 && usersStartedCount >= usersInRoom;

    // ============================================================================
    // Utility Functions & Callbacks
    // ============================================================================

    // Debounced function to send player sync events
    const sendSyncEvent = useRef(
        debounce((event: SyncPayload['event'], time ? : number) => {
            if (!syncEnabled || !echoRef.current) return;
            console.log(`${LOG_PREFIX} SYNC SEND [${event}]${time !== undefined ? `: ${time.toFixed(2)}` : ''} from ${syncSource}`);
            axios.post(`/api/rooms/${room.name}/sync`, {
                event,
                time,
                source: syncSource
            })
                .catch(err => console.error(`${LOG_PREFIX} Sync send fail [${event}]:`, err));
        }, DEBOUNCE_SYNC_MS)
    ).current;

    // Starts polling the YouTube player for current time
    const startPolling = useCallback(() => {
        if (pollerRef.current === null) {
            console.log(`${LOG_PREFIX} Starting player time polling.`);
            pollerRef.current = window.setInterval(() => {
                if (playerRef.current?.getCurrentTime) {
                    try {
                        const currentTime = playerRef.current.getCurrentTime();
                        // Update state only if time changed significantly
                        setSeekTime(prevTime => Math.abs(currentTime - prevTime) > 0.25 ? currentTime : prevTime);
                    } catch (e) {
                        console.error(`${LOG_PREFIX} Poll error:`, e);
                        stopPolling(); // Stop polling on error
                    }
                }
            }, POLLING_INTERVAL_MS);
        }
    }, []); // Empty dependency array: function identity is stable

    // Stops polling the YouTube player
    const stopPolling = useCallback(() => {
        if (pollerRef.current !== null) {
            console.log(`${LOG_PREFIX} Stopping player time polling.`);
            clearInterval(pollerRef.current);
            pollerRef.current = null;
        }
    }, []);

    // ============================================================================
    // WebRTC Core Logic
    // ============================================================================

    /**
     * Closes a specific peer connection and cleans up associated resources.
     */
    const closePeerConnection = useCallback((peerId: string) => {
        const pcEntry = peerConnections.current[peerId];
        if (pcEntry) {
            console.log(`${LOG_PREFIX} Closing PC with ${peerId}`);
            const pc = pcEntry.connection;
            // Detach all event listeners
            pc.onicecandidate = pc.ontrack = pc.onnegotiationneeded = pc.oniceconnectionstatechange = pc.onconnectionstatechange = pc.onsignalingstatechange = null;
            pc.close();
            delete peerConnections.current[peerId]; // Remove from ref

            // Remove stream from React state to update UI
            setRemoteStreams(prev => {
                if (!prev[peerId]) return prev; // Already removed
                const newState = { ...prev };
                delete newState[peerId];
                console.log(`${LOG_PREFIX} Removed remote stream state for ${peerId}`);
                return newState;
            });
            console.log(`${LOG_PREFIX} PC ${peerId} closed.`);
        }
    }, []); // Empty dependency array: function identity is stable

    /**
     * Sends a signaling message (offer, answer, candidate) to a peer via the backend.
     */
    const sendSignal = useCallback((signal: PeerSignal) => {
        console.log(`${LOG_PREFIX} SIGNAL SEND [${signal.type}] from ${signal.source} to ${signal.target}`);
        if (!echoRef.current) {
            console.error(`${LOG_PREFIX} Echo not ready for sendSignal.`);
            return;
        }
        axios.post(`/api/rooms/${room.name}/webrtc-signal`, signal)
            .catch(err => {
                console.error(`${LOG_PREFIX} Signal send fail [${signal.type}] to ${signal.target}:`, err);
                setError(`Signal send fail: ${err.message}`);
            });
    }, [room.name]); // Depends only on room name

    /**
     * Creates a new RTCPeerConnection object for a given peer.
     * Attaches all necessary event handlers.
     * Adds existing local tracks if available.
     * Does NOT initiate the offer/answer exchange (handled by onnegotiationneeded).
     */
    const createPeerConnection = useCallback(async (targetId: string, initiator: boolean): Promise < RTCPeerConnection | null > => {
        const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${targetId})`;

        // Prevent self-connection or duplicate connections
        if (targetId === syncSource) { console.warn(`${logPcPrefix} Self conn reject.`); return null; }
        if (peerConnections.current[targetId]) { console.log(`${logPcPrefix} Already exists.`); return peerConnections.current[targetId].connection; }

        console.log(`${logPcPrefix} Creating new RTCPeerConnection. Initiator: ${initiator}`);
        let pc: RTCPeerConnection;
        try {
            pc = new RTCPeerConnection(rtcConfig);
        } catch (e) {
            console.error(`${logPcPrefix} Creation fail:`, e);
            setError(`PC Create fail: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }

        // Store immediately in ref to handle incoming signals
        peerConnections.current[targetId] = { connection: pc, stream: null, sourceId: targetId };
        console.log(`${logPcPrefix} Stored ref.`);

        // --- Event Handlers ---

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Send candidate to the peer
                sendSignal({ type: 'ice-candidate', data: event.candidate.toJSON(), source: syncSource, target: targetId });
            } else {
                console.log(`${logPcPrefix} ICE gather complete.`);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`${logPcPrefix} ICE state: ${pc.iceConnectionState}`);
            // Handle failures and cleanup
            if (pc.iceConnectionState === 'failed') {
                setError(`ICE fail ${targetId.substring(7,12)}`);
                console.warn(`${logPcPrefix} ICE fail. Restarting?`);
                // Attempt ICE restart if supported, otherwise close
                if (pc.restartIce) { try { pc.restartIce(); } catch(e) { console.error(`${logPcPrefix} restartIce failed:`, e); closePeerConnection(targetId); } }
                else { closePeerConnection(targetId); }
            } else if (pc.iceConnectionState === 'closed') {
                closePeerConnection(targetId); // Ensure cleanup if closed externally
            } else if (pc.iceConnectionState === 'disconnected') {
                console.warn(`${logPcPrefix} ICE Disconnected. Waiting...`);
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`${logPcPrefix} Conn state: ${pc.connectionState}`);
            // Update UI status and handle failures
            switch (pc.connectionState) {
                case 'connecting': setStatus(`Conn ${targetId.substring(7, 12)}...`); break;
                case 'connected': setStatus(`OK ${targetId.substring(7, 12)}`); break;
                case 'failed': setError(`Conn Fail ${targetId.substring(7, 12)}`); console.error(`${logPcPrefix} Conn Fail.`); closePeerConnection(targetId); break;
                case 'disconnected': setStatus(`Lost ${targetId.substring(7, 12)}`); break;
                case 'closed': setStatus(`Closed ${targetId.substring(7, 12)}`); closePeerConnection(targetId); break; // Ensure cleanup
            }
        };

        pc.onsignalingstatechange = () => { console.log(`${logPcPrefix} Signal state: ${pc.signalingState}`); };

        // Handle incoming media tracks from the peer
        pc.ontrack = (event) => {
            console.log(`${logPcPrefix} ONTRACK! Streams: ${event.streams.length}, Kind: ${event.track.kind}`);
            if (event.streams?.[0]) {
                const remoteStream = event.streams[0];
                console.log(`${logPcPrefix} Got remote stream ${remoteStream.id}, Tracks: ${remoteStream.getTracks().length}, Active: ${remoteStream.active}`);
                // Store stream reference
                if (peerConnections.current[targetId]) { peerConnections.current[targetId].stream = remoteStream; }
                // Update React state to trigger UI update
                setRemoteStreams(prev => {
                    // Avoid unnecessary re-renders if stream object is identical
                    if (prev[targetId]?.id === remoteStream.id && prev[targetId]?.active === remoteStream.active) return prev;
                    console.log(`${logPcPrefix} Updating remote stream state.`);
                    return { ...prev, [targetId]: remoteStream };
                });
            } else {
                console.warn(`${logPcPrefix} ONTRACK event missing stream[0].`);
            }
        };

        // Automatically handle renegotiation when tracks are added/removed locally
        pc.onnegotiationneeded = async () => {
            console.log(`${logPcPrefix} Negotiation needed. Signal state: ${pc.signalingState}`);
            // Avoid negotiation loops if not stable
            if (pc.signalingState !== 'stable') { console.warn(`${logPcPrefix} Neg needed but not stable (${pc.signalingState}). Abort.`); return; }
            try {
                console.log(`${logPcPrefix} Creating neg offer...`);
                const offer = await pc.createOffer();
                // Check state again before setting local description
                if (pc.signalingState !== 'stable') { console.warn(`${logPcPrefix} Not stable before setLocalDesc neg. Abort.`); return; }
                console.log(`${logPcPrefix} Setting neg local desc.`);
                await pc.setLocalDescription(offer);
                console.log(`${logPcPrefix} Sending neg offer.`);
                sendSignal({ type: 'offer', data: pc.localDescription!.toJSON(), source: syncSource, target: targetId });
            } catch (err) {
                console.error(`${logPcPrefix} Neg offer fail:`, err);
                setError(`Neg Err: ${err instanceof Error ? err.message : String(err)}`);
                closePeerConnection(targetId); // Close connection on failure
            }
        };

        // Add any existing local tracks to the new connection
        if (localStream) {
            console.log(`${logPcPrefix} Adding ${localStream.getTracks().length} initial tracks.`);
            localStream.getTracks().forEach(track => {
                try { pc.addTrack(track, localStream); } catch (e) { console.error(`${logPcPrefix} Add initial track ${track.kind} fail:`, e); }
            });
        } else {
            console.log(`${logPcPrefix} No initial stream to add tracks.`);
        }

        console.log(`${logPcPrefix} Setup complete.`);
        return pc;
    }, [localStream, sendSignal, syncSource, closePeerConnection, rtcConfig]); // Added rtcConfig dep

    /**
     * Handles incoming signaling messages (offer, answer, candidate) from peers.
     */
    const handleWebRTCSignal = useCallback(async (signal: PeerSignal) => {
        const { type, data, source: peerId, target } = signal;
        const logSigPrefix = `${LOG_PREFIX} SIGNAL RECV [${type}] from ${peerId} to ${target}`;

        // Ignore signals not for us or from ourselves
        if (target !== syncSource || peerId === syncSource) return;

        console.log(`${logSigPrefix}`);
        const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${peerId})`;
        let pcEntry = peerConnections.current[peerId];
        let pc = pcEntry?.connection;

        // --- Temporary fix for potential backend newline issue ---
        // @ts-ignore - Accessing sdp directly if data is SessionDescription
        if (data && data.sdp) { data.sdp += '\n'; }
        // ---------------------------------------------------------

        try {
            switch (type) {
                // Handle incoming Offer from a peer
                case 'offer':
                    {
                        console.log(`${logSigPrefix} Processing...`);
                        const offer = data as RTCSessionDescriptionInit;
                        const isExisting = !!pc;

                        // Create connection if it doesn't exist (peer initiated)
                        if (!pc) {
                            console.log(`${logPcPrefix} Creating conn for offer.`);
                            pc = await createPeerConnection(peerId, false); // We are not the initiator
                            if (!pc) return; // Stop if creation failed
                            pcEntry = peerConnections.current[peerId];
                        } else {
                            console.log(`${logPcPrefix} Offer for existing conn. State: ${pc.signalingState}`);
                        }

                        // --- Glare Handling (Offer Collision) ---
                        // Simple strategy: 'higher' ID is impolite and ignores colliding offer
                        const amIPolite = syncSource < peerId;
                        const collision = pc.signalingState === 'have-local-offer';
                        if (collision && !amIPolite) {
                            console.warn(`${logPcPrefix} Offer collision, impolite peer ignores.`);
                            return; // Ignore the incoming offer
                        }
                        // --- End Glare Handling ---

                        console.log(`${logPcPrefix} Setting remote desc (offer).`);
                        try {
                            await pc.setRemoteDescription(new RTCSessionDescription(offer));
                            console.log(`${logPcPrefix} Remote desc (offer) OK.`);
                        } catch (e) {
                            console.error(`${logPcPrefix} Set remote desc (offer) ERR:`, e);
                            // Polite peer rollback strategy for glare
                            if (collision && amIPolite) {
                                console.log(`${logPcPrefix} Polite rollback.`);
                                await pc.setLocalDescription({ type: 'rollback' });
                                console.log(`${logPcPrefix} Retrying set remote desc.`);
                                await pc.setRemoteDescription(new RTCSessionDescription(offer));
                                console.log(`${logPcPrefix} Retry set remote desc OK.`);
                            } else {
                                throw e; // Re-throw other errors
                            }
                        }

                        // Add local tracks *before* creating answer
                        if (localStream && pcEntry) {
                            console.log(`${logPcPrefix} Checking local tracks pre-answer.`);
                            localStream.getTracks().forEach(track => {
                                // Ensure track is not already added by a sender
                                if (!pc !.getSenders().find(s => s.track === track)) {
                                    try { pc !.addTrack(track, localStream); } catch (e) { console.error(`${logPcPrefix} Add track pre-answer ERR:`, e)}
                                }
                            });
                        }

                        // Create and send the Answer
                        console.log(`${logPcPrefix} Creating answer...`);
                        const answer = await pc.createAnswer();
                        console.log(`${logPcPrefix} Setting local desc (answer).`);
                        await pc.setLocalDescription(answer);
                        console.log(`${logPcPrefix} Sending answer.`);
                        sendSignal({ type: 'answer', data: pc.localDescription!.toJSON(), source: syncSource, target: peerId });
                        break;
                    }

                // Handle incoming Answer from a peer
                case 'answer':
                    {
                        console.log(`${logSigPrefix} Processing...`);
                        if (!pc) { console.error(`${logPcPrefix} Answer no PC.`); return; }
                        const answer = data as RTCSessionDescriptionInit;

                        // Only process answer if we are expecting one
                        if (pc.signalingState !== 'have-local-offer') {
                            console.warn(`${logPcPrefix} Answer unexpected state: ${pc.signalingState}. Ignoring.`);
                            return;
                        }

                        console.log(`${logPcPrefix} Setting remote desc (answer).`);
                        try {
                            await pc.setRemoteDescription(new RTCSessionDescription(answer));
                            console.log(`${logPcPrefix} Remote desc (answer) OK.`);
                        } catch (e) {
                            console.error(`${logPcPrefix} Set remote desc (answer) ERR:`, e);
                            setError(`Answer ERR ${peerId.substring(7,12)}: ${e instanceof Error ? e.message : String(e)}`);
                            closePeerConnection(peerId); // Close on failure
                        }
                        break;
                    }

                // Handle incoming ICE Candidate from a peer
                case 'ice-candidate':
                    {
                        // Skip logging for noise reduction if needed
                        // console.log(`${logSigPrefix} Processing...`);
                        if (!pc) { /* console.warn(`${logPcPrefix} ICE no PC.`); */ return; }
                        const candidate = data as RTCIceCandidateInit;
                        // Ignore empty candidates (signals end of gathering)
                        if (!candidate?.candidate) return;

                        try {
                            // Add candidate even before remote description is set
                            await pc.addIceCandidate(new RTCIceCandidate(candidate));
                        } catch (err) {
                            // Ignore benign errors if connection is already closed
                            if (pc.signalingState !== 'closed') {
                                console.warn(`${logPcPrefix} Add ICE ERR:`, err);
                            }
                        }
                        break;
                    }
            }
        } catch (err) {
            // Catch errors from the switch/case logic or async operations
            console.error(`${logPcPrefix} Signal handle ERR [${type}]:`, err);
            setError(`Signal ${type} ERR: ${err instanceof Error ? err.message : String(err)}`);
            if (peerId && pc) {
                console.error(`${logPcPrefix} Closing conn due to signal err.`);
                closePeerConnection(peerId);
            }
        }
    }, [syncSource, createPeerConnection, sendSignal, localStream, closePeerConnection]); // Dependencies


    // ============================================================================
    // React Effects
    // ============================================================================

    /** Effect to extract Video ID from room URL */
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: Extracting Video ID from`, room.youtube_video_id);
        try {
            const url = new URL(room.youtube_video_id);
            const videoIdParam = url.searchParams.get('v');
            if (videoIdParam) {
                setVideoId(videoIdParam);
            } else {
                // Fallback if 'v' parameter is missing but it's a valid URL
                setVideoId(room.youtube_video_id);
            }
        } catch (e) {
            // If not a valid URL, assume the whole string is the ID
            console.warn(`${LOG_PREFIX} Not a valid URL, using raw string as ID: ${room.youtube_video_id}`);
            setVideoId(room.youtube_video_id);
        }
    }, [room.youtube_video_id]);

    /** Effect to load the YouTube IFrame Player API */
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: YT API Load check. Loaded: ${apiLoadedRef.current}`);
        if (apiLoadedRef.current || window.YT?.Player) {
            if (!apiLoadedRef.current) apiLoadedRef.current = true; // Mark loaded if window.YT existed
            setStatus('YouTube API ready');
            return; // API already available
        }

        console.log(`${LOG_PREFIX} Injecting YT API script.`);
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.async = true;
        document.body.appendChild(tag);

        // Define the global callback function
        window.onYouTubeIframeAPIReady = () => {
            console.log(`${LOG_PREFIX} window.onYouTubeIframeAPIReady Fired!`);
            apiLoadedRef.current = true;
            setStatus('YouTube API ready');
        };

        // Cleanup function
        return () => {
            console.log(`${LOG_PREFIX} Cleanup Effect: YouTube API Loader`);
            // Reset the callback to avoid potential issues if component unmounts fast
            window.onYouTubeIframeAPIReady = () => {};
            // Optionally remove the script tag, though often not necessary
            // document.body.removeChild(tag);
        }
    }, []); // Run only once on mount

    /** Effect to initialize the YouTube Player instance */
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: Player Init Check. API: ${apiLoadedRef.current}, Vid: ${!!videoId}, Start: ${start}, AllStart: ${allUsersStarted}, Cont: ${!!playerContainerRef.current}, Player: ${!!playerRef.current}`);

        // Conditions for player initialization
        const canInitialize = apiLoadedRef.current && videoId && start && allUsersStarted && playerContainerRef.current;

        if (!canInitialize) {
            console.log(`${LOG_PREFIX} Player init conditions unmet.`);
            // Destroy player if conditions become unmet (e.g., users leave/unstart)
            if (playerRef.current && (!start || !allUsersStarted)) {
                console.log(`${LOG_PREFIX} Destroying player due to unmet conditions.`);
                try { playerRef.current.destroy(); } catch (e) {}
                playerRef.current = null;
                stopPolling();
                setDuration(0);
                setSeekTime(0);
            }
            return; // Exit if conditions not met
        }

        // Avoid re-initializing if player already exists
        if (playerRef.current) {
            console.log(`${LOG_PREFIX} Player already initialized.`);
            return;
        }

        // --- Initialize Player ---
        setStatus('Initializing YouTube player...');
        console.log(`${LOG_PREFIX} YT Player Init: Creating for ${videoId}`);
        try {
            playerRef.current = new window.YT.Player(playerContainerRef.current, {
                videoId,
                playerVars: {
                    autoplay: 0,
                    controls: 0, // Use custom controls
                    rel: 0,
                    modestbranding: 1,
                    disablekb: 1, // Disable keyboard shortcuts
                    fs: 0, // Disable fullscreen button
                    origin: window.location.origin, // Security measure
                },
                events: {
                    onReady: (e: any) => {
                        console.log(`${LOG_PREFIX} YT Ready`);
                        setStatus('Player ready');
                        try {
                            const d = e.target.getDuration();
                            console.log(`${LOG_PREFIX} Duration: ${d}`);
                            setDuration(d);
                        } catch (err) { console.error(`${LOG_PREFIX} Get duration error:`, err); }
                    },
                    onStateChange: (e: any) => {
                        const stateMap = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED'};
                        // @ts-ignore
                        const stateName = stateMap[e.data] || 'UNKNOWN';
                        console.log(`${LOG_PREFIX} YT State: ${e.data} (${stateName})`);
                        const currentTime = playerRef.current?.getCurrentTime?.();

                        if (syncEnabled) {
                            switch (e.data) {
                                case window.YT.PlayerState.PLAYING:
                                    sendSyncEvent('play'); startPolling(); break;
                                case window.YT.PlayerState.PAUSED:
                                    sendSyncEvent('pause'); stopPolling(); break;
                                case window.YT.PlayerState.BUFFERING:
                                    if (currentTime !== undefined) { sendSyncEvent.flush(); sendSyncEvent('seek', currentTime); } stopPolling(); break;
                                case window.YT.PlayerState.ENDED:
                                    stopPolling(); sendSyncEvent('pause'); break; // Treat end as pause
                                case window.YT.PlayerState.CUED:
                                    stopPolling(); try { setDuration(playerRef.current.getDuration()); } catch(err) {} break; // Update duration if cued
                                default:
                                    stopPolling(); break;
                            }
                        } else {
                            // Handle polling even if sync is off
                            if (e.data === window.YT.PlayerState.PLAYING) startPolling();
                            else stopPolling();
                        }
                    },
                    onError: (e: any) => {
                        console.error(`${LOG_PREFIX} YT Player Error Code: ${e.data}`);
                        setError(`YT Player Err ${e.data}`);
                        stopPolling();
                    }
                },
            });
        } catch (error) {
            console.error(`${LOG_PREFIX} YT Player Create Fail:`, error);
            setError(`YT Init Fail: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [videoId, start, allUsersStarted, syncEnabled, sendSyncEvent, startPolling, stopPolling]); // Dependencies

    /** Effect to Setup Laravel Echo and Listeners */
    useEffect(() => {
        if (!room.name) { console.log(`${LOG_PREFIX} Effect: Echo setup skipped (no room name).`); return; }
        if (echoRef.current) { console.log(`${LOG_PREFIX} Effect: Echo setup skipped (already exists).`); return; }

        console.log(`${LOG_PREFIX} Effect: Echo Setup starting for ${room.name}`);
        setStatus('Connecting...');
        window.Pusher = Pusher;
        let echoInstance: Echo < any > ;
        try {
            echoInstance = new Echo({
                broadcaster: 'pusher',
                key: import.meta.env.VITE_PUSHER_APP_KEY,
                cluster: import.meta.env.VITE_PUSHER_APP_CLUSTER,
                forceTLS: true,
            });
            echoRef.current = echoInstance;
            setStatus('Connected.');
        } catch (e) {
            console.error(`${LOG_PREFIX} Echo Init Fail:`, e);
            setError(`Connect Fail: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        // Define channel names
        const channels = {
            sync: `public-room.${room.name}`,
            started: `public-room-users-started.${room.name}`,
            webrtc: `public-room-webrtc.${room.name}`,
            joined: `public-room-users-joined.${room.name}`,
            left: `public-room-users-left.${room.name}`
        };
        console.log(`${LOG_PREFIX} Subscribing to channels:`, channels);

        // --- Channel Listeners ---

        // Sync Listener
        echoInstance.channel(channels.sync)
            .listen('.sync', (eventData: SyncEvent) => {
                if (eventData.source === syncSource || !syncEnabled || !playerRef.current) return;
                const { event, time } = eventData.payload;
                console.log(`${LOG_PREFIX} SYNC RECV [${event}]${time !== undefined ? `: ${time.toFixed(2)}` : ''} from ${eventData.source}`);
                try {
                    const player = playerRef.current;
                    if (!player) return;
                    const currentState = player.getPlayerState?.();
                    const currentTime = player.getCurrentTime?.() ?? 0;

                    if (event === 'play' && currentState !== window.YT.PlayerState.PLAYING) player.playVideo();
                    else if (event === 'pause' && currentState !== window.YT.PlayerState.PAUSED) player.pauseVideo();
                    else if (event === 'seek' && time != null && Math.abs(time - currentTime) > SEEK_TOLERANCE_S) {
                        player.seekTo(time, true);
                        setSeekTime(time); // Update UI slider
                    }
                } catch (e) { console.error(`${LOG_PREFIX} Sync handle ERR [${event}]:`, e); }
            });

        // User Started Listener
        echoInstance.channel(channels.started)
            .listen('.user-started', (data: { source: string; startedCount ? : number }) => {
                console.log(`${LOG_PREFIX} RECV .user-started from ${data.source}`);
                // Prefer backend count if available for accuracy
                if (data.startedCount !== undefined) {
                    setUsersStartedCount(data.startedCount);
                } else {
                    // Fallback: Increment locally (less robust)
                    setUsersStartedCount(prevCount => prevCount + 1);
                }
            });

        // WebRTC Signaling Listener
        echoInstance.channel(channels.webrtc)
            .listen('.signal', (eventData: { signal: PeerSignal }) => {
                if (eventData?.signal) {
                    handleWebRTCSignal(eventData.signal);
                } else {
                    console.warn(`${LOG_PREFIX} Malformed signal received:`, eventData);
                }
            });

        // User Joined Listener
        echoInstance.channel(channels.joined)
            .listen('.user-joined', (data: { source: string; currentUsers ? : string[] }) => {
                console.log(`${LOG_PREFIX} RECV .user-joined from ${data.source}`);
                // Update user list (prefer backend list if provided)
                if (data.currentUsers) { setUserList(data.currentUsers); }
                else { setUserList(prev => prev.includes(data.source) ? prev : [...prev, data.source]); }

                // Initiate connection to the new user *if* our media is already active
                if (data.source !== syncSource && localStream) {
                    console.log(`${LOG_PREFIX} New user ${data.source} joined, initiating connection.`);
                    createPeerConnection(data.source, true); // We initiate
                }
            });

        // User Left Listener
        echoInstance.channel(channels.left)
            .listen('.user-left', (data: { source: string; currentUsers ? : string[] }) => {
                console.log(`${LOG_PREFIX} RECV .user-left from ${data.source}`);
                if (data.source !== syncSource) {
                    closePeerConnection(data.source); // Clean up connection
                    // Update user list (prefer backend list if provided)
                    if (data.currentUsers) { setUserList(data.currentUsers); }
                    else { setUserList(prev => prev.filter(id => id !== data.source)); }
                    // Adjust started count if necessary (depends on backend logic)
                }
            });

        // Announce our presence after listeners are set up
        console.log(`${LOG_PREFIX} Announcing self join (${syncSource}).`);
        axios.post(`/api/rooms/${room.name}/user-joined`, { source: syncSource })
            .then(response => {
                console.log(`${LOG_PREFIX} Join announced. Initial state:`, response.data);
                // Set initial state based on reliable response from backend
                if (response.data?.currentUsers) { setUserList(response.data.currentUsers); }
                if (response.data?.startedCount !== undefined) { setUsersStartedCount(response.data.startedCount); }
            })
            .catch(err => {
                console.error(`${LOG_PREFIX} Join announce fail:`, err);
                setError(`Join fail: ${err.message}`);
            });

        console.log(`${LOG_PREFIX} Echo setup complete.`);

        // Cleanup is handled in the main unmount effect

    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [room.name]); // Re-run only if room.name changes

    /** Effect for Main Component Cleanup on Unmount */
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: Mount setup complete.`);
        // Return the cleanup function
        return () => {
            console.warn(`${LOG_PREFIX} Effect: Cleanup Running! Component is unmounting.`);

            // Stop player polling
            console.log(`${LOG_PREFIX} Cleanup: Stopping polling.`);
            stopPolling();

            // Destroy YouTube player instance
            if (playerRef.current) {
                console.log(`${LOG_PREFIX} Cleanup: Destroying player.`);
                try { playerRef.current.destroy(); } catch (e) {}
                playerRef.current = null;
            }

            // Stop local media tracks
            if (localStream) {
                console.log(`${LOG_PREFIX} Cleanup: Stopping local stream tracks.`);
                localStream.getTracks().forEach(track => track.stop());
                // No need to setLocalStream(null) here, state is cleared on unmount
            }

            // Close all active peer connections
            console.log(`${LOG_PREFIX} Cleanup: Closing peers (${Object.keys(peerConnections.current).length}).`);
            Object.keys(peerConnections.current).forEach(closePeerConnection);
            peerConnections.current = {}; // Clear the ref
            // No need to setRemoteStreams({}), state is cleared

            // Disconnect from Laravel Echo
            if (echoRef.current) {
                console.log(`${LOG_PREFIX} Cleanup: Leaving Echo channels & disconnecting.`);
                const echo = echoRef.current;
                const rn = room.name;
                // Leave all subscribed channels
                [`public-room.${rn}`, `public-room-users-started.${rn}`, `public-room-webrtc.${rn}`, `public-room-users-joined.${rn}`, `public-room-users-left.${rn}`]
                .forEach(c => { /* console.log(`${LOG_PREFIX} Cleanup: Leaving ${c}`); */ echo.leave(c); });
                echo.disconnect();
                console.log(`${LOG_PREFIX} Cleanup: Echo disconnected.`);
                echoRef.current = null;
            }

            // Send user-left notification to backend (best effort)
            if (room.name && syncSource) {
                console.log(`${LOG_PREFIX} Cleanup: Sending user-left notification.`);
                // Consider navigator.sendBeacon for more reliability on page close
                axios.post(`/api/rooms/${room.name}/user-left`, { source: syncSource })
                    .catch(err => console.log(`${LOG_PREFIX} Cleanup user-left failed:`, err));
            }
            console.warn(`${LOG_PREFIX} Effect: Cleanup Complete.`);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [closePeerConnection, room.name, stopPolling, syncSource]); // Dependencies needed by cleanup


    // --- Effects for Decoupled Media Handling ---

    /** Effect to update the local video element's srcObject when localStream changes */
    useEffect(() => {
        console.log(`${LOG_PREFIX} Effect: Update local video srcObject. Stream ID: ${localStream?.id}, Active: ${localStream?.active}`);
        if (localVideoRef.current) {
            const videoElement = localVideoRef.current;
            const currentSrc = videoElement.srcObject;

            if (localStream && localStream.active) {
                // Assign only if different to avoid unnecessary operations
                if (currentSrc !== localStream) {
                    console.log(`${LOG_PREFIX} Effect: Assigning stream ${localStream.id} to local video.`);
                    videoElement.srcObject = localStream;
                    // Attempt to play, catch errors silently for browsers that block it
                    videoElement.play().catch(e => console.warn(`${LOG_PREFIX} Local preview autoplay error: ${e.message}`));
                } else {
                     console.log(`${LOG_PREFIX} Effect: srcObject already set to this stream.`);
                }
            } else {
                // Clear srcObject if stream is null or inactive
                if (currentSrc !== null) {
                    console.log(`${LOG_PREFIX} Effect: Clearing local video srcObject.`);
                    videoElement.srcObject = null;
                }
            }
        }
    }, [localStream]); // Re-run only when the localStream state object changes

    /** Effect to handle peer connection updates (tracks, initiating) when media state changes */
    useEffect(() => {
        const logEffectPrefix = `${LOG_PREFIX} Effect (Peer Update):`;
        console.log(`${logEffectPrefix} Running. Cam: ${cameraEnabled}, Mic: ${micEnabled}, Stream: ${localStream?.id}, Users: ${userList.length}`);

        const mediaActive = (cameraEnabled || micEnabled) && localStream?.active;

        if (!mediaActive || !localStream) {
            console.log(`${logEffectPrefix} Media not active or no stream. Skipping peer updates.`);
            // If media is off, ensure the "first check" flag is reset for next time
            if (isFirstMediaCheckRef.current) {
                 console.log(`${logEffectPrefix} Media off, resetting first check flag.`);
                 isFirstMediaCheckRef.current = false;
            }
            return;
        }

        // --- Media is Active ---
        console.log(`${logEffectPrefix} Media active with stream ${localStream.id}. Processing peers.`);
        const videoTrack = localStream.getVideoTracks()[0] || null;
        const audioTrack = localStream.getAudioTracks()[0] || null;
        const currentPeers = peerConnections.current;
        const currentPeerIds = Object.keys(currentPeers);

        // Determine if this is the first time this effect runs since media became active
        let initiateConnections = false;
        if (!isFirstMediaCheckRef.current) {
            console.log(`${logEffectPrefix} First media check running.`);
            isFirstMediaCheckRef.current = true; // Mark check as done for this active session
            initiateConnections = true;
        }

        let trackUpdateError: Error | null = null;
        let createConnectionError: Error | null = null;

        // --- 1. Update Tracks for Existing Connections ---
        console.log(`${logEffectPrefix} Updating tracks for ${currentPeerIds.length} existing connections.`);
        currentPeerIds.forEach(peerId => {
            if (trackUpdateError) return; // Stop processing if an error occurred
            const { connection } = currentPeers[peerId];
            const logPcPrefix = `${LOG_PREFIX} PC (${syncSource} <-> ${peerId})`;
            try {
                // --- Sync Video Track ---
                const videoSender = connection.getSenders().find(s => s.track?.kind === 'video');
                if (videoTrack && videoSender) {        // Have track, have sender: Replace if different
                    if (videoSender.track !== videoTrack) { console.log(`${logPcPrefix} Replacing video track.`); videoSender.replaceTrack(videoTrack); }
                } else if (videoTrack && !videoSender) { // Have track, no sender: Add
                    console.log(`${logPcPrefix} Adding video track sender.`); connection.addTrack(videoTrack, localStream);
                } else if (!videoTrack && videoSender) { // No track, have sender: Remove
                    console.log(`${logPcPrefix} Removing video track sender.`); connection.removeTrack(videoSender);
                }

                // --- Sync Audio Track ---
                const audioSender = connection.getSenders().find(s => s.track?.kind === 'audio');
                 if (audioTrack && audioSender) {        // Have track, have sender: Replace if different
                     if (audioSender.track !== audioTrack) { console.log(`${logPcPrefix} Replacing audio track.`); audioSender.replaceTrack(audioTrack); }
                 } else if (audioTrack && !audioSender) { // Have track, no sender: Add
                     console.log(`${logPcPrefix} Adding audio track sender.`); connection.addTrack(audioTrack, localStream);
                 } else if (!audioTrack && audioSender) { // No track, have sender: Remove
                     console.log(`${logPcPrefix} Removing audio track sender.`); connection.removeTrack(audioSender);
                 }
            } catch (e) {
                console.error(`!!! ${logPcPrefix} CRITICAL ERROR updating tracks in Effect:`, e);
                trackUpdateError = e instanceof Error ? e : new Error(String(e));
            }
        });
        console.log(`${logEffectPrefix} Finished updating existing connections.`);

        // --- 2. Initiate Connections if First Media Activation ---
        if (initiateConnections) {
            console.log(`${logEffectPrefix} Initiating connections for ${userList.length} users (if not connected).`);
            Promise.allSettled( // Attempt all connections, log failures
                userList.map(async (peerId) => {
                    if (peerId !== syncSource && !currentPeers[peerId]) { // If not self and no existing connection
                        try {
                            console.log(`${logEffectPrefix} Initiating connection to ${peerId}`);
                            await createPeerConnection(peerId, true); // We are the initiator
                        } catch (e) {
                            console.error(`!!! ${logEffectPrefix} CRITICAL ERROR initiating connection to ${peerId}:`, e);
                            if (!createConnectionError) createConnectionError = e instanceof Error ? e : new Error(String(e)); // Store first error
                        }
                    }
                })
            ).then((results) => {
                console.log(`${logEffectPrefix} Finished initiating connections attempt.`);
                const failedCount = results.filter(r => r.status === 'rejected').length;
                if (failedCount > 0 || createConnectionError) {
                    setError(`WebRTC Init Error: Failed ${failedCount} connections. ${createConnectionError?.message ?? ''}`);
                }
            });
        }

        // --- Report Errors ---
        if (trackUpdateError) { setError(`WebRTC Update Error: ${trackUpdateError.message}`); }

        // --- Effect Cleanup ---
        // Reset the 'first check' flag only when media actually becomes inactive.
        return () => {
             // Check the state *at the time of cleanup*
             // Note: This cleanup runs *before* the next render if deps change,
             // or on unmount. It might not have the absolute latest state if called between renders.
             const isMediaStillActive = (cameraEnabled || micEnabled) && localStream?.active;
             if (!isMediaStillActive && isFirstMediaCheckRef.current) {
                  console.log(`${logEffectPrefix} Cleanup: Resetting first media check flag.`);
                  isFirstMediaCheckRef.current = false;
             }
        }
    }, [localStream, cameraEnabled, micEnabled, userList, createPeerConnection, syncSource, closePeerConnection]); // Added closePeerConnection


    // ============================================================================
    // User Action Handlers
    // ============================================================================

    /** Handles the "Start" button click */
    const sendUserStarted = () => {
        if (start) return; // Prevent multiple clicks
        console.log(`${LOG_PREFIX} Action: Start.`);
        setStart(true);
        setStatus("Waiting for others...");
        axios.post(`/api/rooms/${room.name}/user-started`, { source: syncSource })
            .then(() => console.log(`${LOG_PREFIX} Sent user-started signal.`))
            .catch(err => {
                console.error(`${LOG_PREFIX} Fail start signal:`, err);
                setError(`Fail start: ${err.message}`);
                setStart(false); // Rollback state on failure
                setStatus("Fail start signal.");
            });
    };

    /** Handles manual Play button click */
    const play = () => {
        if (!playerRef.current || !allUsersStarted) {
            console.warn(`${LOG_PREFIX} Play rejected: Player not ready or not all started.`);
            return;
        }
        console.log(`${LOG_PREFIX} Action: Manual Play.`);
        playerRef.current.playVideo();
    };

    /** Handles manual Pause button click */
    const pause = () => {
        if (!playerRef.current || !allUsersStarted) {
             console.warn(`${LOG_PREFIX} Pause rejected: Player not ready or not all started.`);
             return;
        }
        console.log(`${LOG_PREFIX} Action: Manual Pause.`);
        playerRef.current.pauseVideo();
    };

    /** Handles seek bar value change (during drag) */
    const handleSeekChange = (e: React.ChangeEvent < HTMLInputElement > ) => {
        if (!playerRef.current || !allUsersStarted) return;
        const time = parseFloat(e.target.value);
        setSeekTime(time); // Update UI immediately
        playerRef.current.seekTo(time, true); // Seek player
        sendSyncEvent('seek', time); // Send debounced sync event
    };

    /** Handles seek bar mouse up (end of drag) */
    const handleSeekMouseUp = () => {
        // Ensure final position is flushed immediately
        if (syncEnabled && playerRef.current && allUsersStarted) {
            sendSyncEvent.flush(); // Send pending debounced seek first
            const finalTime = playerRef.current.getCurrentTime?.();
            if (finalTime !== undefined) {
                // Send one final explicit seek event
                sendSyncEvent('seek', finalTime);
            }
        }
    };

    /**
     * Toggles the camera ON/OFF.
     * Gets user media and updates localStream state.
     * Relies on useEffect hook [localStream, cameraEnabled] to handle peer updates.
     */
    const toggleCamera = async () => {
        const action = cameraEnabled ? "OFF" : "ON";
        console.log(`${LOG_PREFIX} Action: Toggle Camera ${action}`);

        if (!cameraEnabled) { // --- Turning Camera ON ---
            let videoTrack: MediaStreamTrack | null = null;
            try {
                setStatus('Requesting camera...');
                // Request video, include audio if mic is already enabled
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: micEnabled });
                setStatus('Camera granted.');
                videoTrack = stream.getVideoTracks()[0];
                if (!videoTrack) throw new Error("No video track found.");
                console.log(`${LOG_PREFIX} Got video track ${videoTrack.id}`);

                // Update state: Add new track, remove old video track if exists
                setLocalStream(prevStream => {
                    const updatedStream = prevStream || new MediaStream();
                    const existingTrack = updatedStream.getVideoTracks()[0];
                    if (existingTrack) { updatedStream.removeTrack(existingTrack); /* Don't stop here, track might be used by effect */ }
                    updatedStream.addTrack(videoTrack !);
                    console.log(`${LOG_PREFIX} Queued stream update ADD video ${videoTrack!.id}`);
                    return updatedStream;
                });
                setCameraEnabled(true);
                setStatus('Camera enabled.'); // Optimistic status

            } catch (err) {
                console.error(`${LOG_PREFIX} toggleCamera (ON) ERR:`, err);
                setError(`Cam Err: ${err instanceof Error ? err.message : String(err)}`);
                setStatus('Cam fail.');
                setCameraEnabled(false); // Rollback
                // Stop the track if we obtained it but failed later
                if (videoTrack?.readyState === 'live') { videoTrack.stop(); }
            }
        } else { // --- Turning Camera OFF ---
            try {
                setStatus('Turning cam off...');
                setCameraEnabled(false); // Set state first

                const currentStream = localStream; // Get current stream from state
                if (currentStream) {
                    const track = currentStream.getVideoTracks()[0];
                    if (track) {
                        console.log(`${LOG_PREFIX} Stopping video track ${track.id}`);
                        track.stop();
                        // Update state: Remove the track, set stream to null if no tracks left
                        setLocalStream(prev => {
                            if (!prev) return null;
                            const next = new MediaStream(prev.getTracks().filter(t => t !== track));
                            console.log(`${LOG_PREFIX} Queued stream update REMOVE video ${track.id}`);
                            return next.getTracks().length > 0 ? next : null; // Null if empty
                        });
                        // The useEffect will handle removing track from peers
                    }
                }
                setStatus('Camera disabled.');
            } catch (err) {
                console.error(`${LOG_PREFIX} toggleCamera (OFF) ERR:`, err);
                setError(`Cam disable Err: ${err instanceof Error ? err.message : String(err)}`);
                setStatus('Cam disable fail.');
            }
        }
    };

    /**
     * Toggles the microphone ON/OFF.
     * Gets user media and updates localStream state.
     * Relies on useEffect hook [localStream, micEnabled] to handle peer updates.
     */
    const toggleMic = async () => {
        const action = micEnabled ? "OFF" : "ON";
        console.log(`${LOG_PREFIX} Action: Toggle Mic ${action}`);

        if (!micEnabled) { // --- Turning Mic ON ---
            let audioTrack: MediaStreamTrack | null = null;
            try {
                setStatus('Requesting mic...');
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                setStatus('Mic granted.');
                audioTrack = stream.getAudioTracks()[0];
                if (!audioTrack) throw new Error("No audio track found.");
                console.log(`${LOG_PREFIX} Got audio track ${audioTrack.id}`);

                // Update state: Add new track, remove old audio track if exists
                setLocalStream(prev => {
                    const u = prev || new MediaStream();
                    const e = u.getAudioTracks()[0];
                    if (e) u.removeTrack(e);
                    u.addTrack(audioTrack !);
                    console.log(`${LOG_PREFIX} Queued stream update ADD audio ${audioTrack!.id}`);
                    return u;
                });
                setMicEnabled(true);
                setStatus('Microphone enabled.');

            } catch (err) {
                console.error(`${LOG_PREFIX} toggleMic (ON) ERR:`, err);
                setError(`Mic Err: ${err instanceof Error ? err.message : String(err)}`);
                setStatus('Mic fail.');
                setMicEnabled(false); // Rollback
                if (audioTrack?.readyState === 'live') { audioTrack.stop(); }
            }
        } else { // --- Turning Mic OFF ---
            try {
                setStatus('Turning mic off...');
                setMicEnabled(false); // Set state first

                const currentStream = localStream; // Get current stream from state
                if (currentStream) {
                    const track = currentStream.getAudioTracks()[0];
                    if (track) {
                        console.log(`${LOG_PREFIX} Stopping audio track ${track.id}`);
                        track.stop();
                        // Update state: Remove track, set stream to null if empty
                        setLocalStream(prev => {
                            if (!prev) return null;
                            const next = new MediaStream(prev.getTracks().filter(t => t !== track));
                            console.log(`${LOG_PREFIX} Queued stream update REMOVE audio ${track.id}`);
                            return next.getTracks().length > 0 ? next : null; // Null if empty
                        });
                        // The useEffect will handle removing track from peers
                    }
                }
                setStatus('Microphone disabled.');
            } catch (err) {
                console.error(`${LOG_PREFIX} toggleMic (OFF) ERR:`, err);
                setError(`Mic disable Err: ${err instanceof Error ? err.message : String(err)}`);
                setStatus('Mic disable fail.');
            }
        }
    };

    // ============================================================================
    // Render
    // ============================================================================
    return (
        <AppLayout breadcrumbs={breadcrumbs} >
            <Head title={`Watch: ${room.name}`} />

             { /* Main container */}
            <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4" >
                <div className="max-w-6xl w-full bg-white shadow-lg rounded-2xl overflow-hidden" >

                     { /* Header Section */}
                    <div className="flex items-center justify-between px-6 py-4 border-b flex-wrap gap-y-2" >
                        <div className="flex items-center space-x-3 min-w-0" >
                            <Film className="w-6 h-6 text-indigo-600 flex-shrink-0" />
                            <h2 className="text-xl font-semibold text-gray-800 truncate" title={room.name} > Room: {room.name} </h2>
                        </div >
                        <div className="flex items-center space-x-4 flex-shrink-0" >
                            <label className="flex items-center space-x-1 text-sm text-gray-600 cursor-pointer" title="Enable/Disable YouTube player synchronization" >
                                <input type="checkbox" checked={syncEnabled} onChange={()=> setSyncEnabled(!syncEnabled)} className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500" />
                                <span> Sync </span>
                            </label >
                             <label className="flex items-center space-x-1 text-sm text-gray-600 cursor-pointer" title="Show/Hide Video Chat Panel" >
                                <input type="checkbox" checked={videoChatVisible} onChange={()=> setVideoChatVisible(!videoChatVisible)} className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500" />
                                <span> Video Chat </span>
                             </label>
                             <div className="flex items-center space-x-1" title="Users Started / Total Users" >
                                <Users className="w-5 h-5 text-gray-500" />
                                <span className="text-sm font-medium text-gray-700" > { usersStartedCount } / { usersInRoom } </span>
                             </div >
                        </div >
                    </div > { /* End Header */}


                     { /* Body Flex Container */}
                    <div className="flex flex-col md:flex-row" >

                         { /* Main Content Area (Player/Controls) */}
                        <div className={`flex-grow ${videoChatVisible ? 'md:w-3/4' : 'w-full'}`} >

                             { /* Video Player or Waiting Area */}
                            <div className="relative bg-black aspect-video" >
                                {
                                    (allUsersStarted && start) ? (
                                        // Player Active
                                        <div ref={playerContainerRef} id="youtube-player-container" className="w-full h-full" />
                                    ) : (
                                        // Waiting Area
                                        <div className="w-full h-full flex items-center justify-center text-white p-4" > {
                                            !start ? (
                                                // Show Start Button
                                                <button onClick={sendUserStarted} className="px-8 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-xl transition duration-150 ease-in-out text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-black focus:ring-indigo-400" >
                                                    Join Session & Start
                                                </button>
                                            ) : (
                                                // Show Waiting Message
                                                <div className='text-center' >
                                                    <p className="text-xl mb-2 animate-pulse" > Waiting for others... </p>
                                                    <p className="text-sm" > ({ usersStartedCount } / { usersInRoom } ready) </p>
                                                </div >
                                            )
                                        }
                                        </div>
                                    )
                                }
                            </div >

                             { /* Status/Error Bar */}
                             {
                                (status || error) && (
                                    <div className="px-6 py-1.5 text-xs border-t text-gray-600 bg-gray-50" > {
                                        error ? ( < span className="text-red-600 font-medium" > Error: { error } </span> )
                                              : ( <span > Status: { status } </span> )
                                        }
                                    </div>
                                )
                             }

                             { /* Player Controls */}
                             {
                                (allUsersStarted && start && duration > 0) && (
                                    <div className="px-6 py-4 border-t bg-gray-50 flex flex-col space-y-3" >
                                        { /* Buttons */ }
                                        <div className="flex items-center justify-center space-x-4" >
                                            <button onClick={play} title="Play" className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500" > <Play className="w-5 h-5 text-indigo-700" /> </button>
                                            <button onClick={pause} title="Pause" className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500" > <Pause className="w-5 h-5 text-indigo-700" /> </button>
                                            <button title="Seek to Start" onClick={()=> { setSeekTime(0); playerRef.current?.seekTo(0, true); sendSyncEvent.flush(); sendSyncEvent('seek', 0); }} className="p-2.5 bg-indigo-100 rounded-full hover:bg-indigo-200 transition focus:outline-none focus:ring-2 focus:ring-indigo-500" > <RefreshCw className="w-5 h-5 text-indigo-700" /> </button>
                                        </div >
                                        { /* Seek Bar */ }
                                        <div className="flex items-center space-x-2" >
                                            <span className="text-xs text-gray-600 w-10 text-right font-mono" > { new Date(seekTime * 1000).toISOString().substr(14, 5) } </span>
                                            <input type="range" aria-label="Video Seek Bar" min={0} max={duration} step={0.1} value={seekTime} onChange={handleSeekChange} onMouseUp={handleSeekMouseUp} onTouchEnd={handleSeekMouseUp} className="flex-1 h-1.5 rounded-lg appearance-none bg-gray-300 accent-indigo-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1" />
                                            <span className="text-xs text-gray-600 w-10 text-left font-mono" > { new Date(duration * 1000).toISOString().substr(14, 5) } </span>
                                        </div >
                                    </div>
                                )
                            }
                        </div > { /* End Main Content Area */ }


                         { /* Video Chat Sidebar */ }
                         {
                            videoChatVisible && (
                                <div className="w-full md:w-1/4 border-t md:border-t-0 md:border-l bg-gray-50 flex flex-col" style={{ maxHeight: 'calc(100vh - 100px)', minHeight: '300px' }} >

                                     { /* Sidebar Header & Media Controls */ }
                                    <div className="p-4 border-b sticky top-0 bg-gray-50 z-10 flex-shrink-0" >
                                        <h3 className="font-medium text-gray-700 mb-3 text-center" > Video Chat </h3>
                                        <div className="flex justify-center space-x-3" >
                                            <button onClick={toggleCamera} disabled={!navigator.mediaDevices?.getUserMedia } className={`p-2.5 rounded-full transition duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-1 ${ cameraEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200 focus:ring-green-500' : 'bg-gray-200 text-gray-600 hover:bg-gray-300 focus:ring-gray-500' } ${!navigator.mediaDevices?.getUserMedia ? 'opacity-50 cursor-not-allowed' : ''}`} title={ cameraEnabled ? "Turn camera off" : "Turn camera on" } > { cameraEnabled ? < Video className="w-5 h-5" /> : < VideoOff className="w-5 h-5" />} </button>
                                            <button onClick={toggleMic} disabled={!navigator.mediaDevices?.getUserMedia } className={`p-2.5 rounded-full transition duration-150 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-1 ${ micEnabled ? 'bg-green-100 text-green-700 hover:bg-green-200 focus:ring-green-500' : 'bg-gray-200 text-gray-600 hover:bg-gray-300 focus:ring-gray-500' } ${!navigator.mediaDevices?.getUserMedia ? 'opacity-50 cursor-not-allowed' : ''}`} title={ micEnabled ? "Mute microphone" : "Unmute microphone" } > { micEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />} </button>
                                        </div >
                                    </div > { /* End Sidebar Header */ }

                                    {/* Video Previews Container */}
                                    <div className="p-2 space-y-3 overflow-y-auto flex-grow">
                                        {/* Local Video Preview (remains the same, uses localVideoRef) */}
                                        {(cameraEnabled || micEnabled) && localStream?.active && (
                                            <div className="mb-2">
                                                <p className="text-xs font-medium text-gray-600 mb-1 ml-1 flex items-center"> You <span className="ml-1 px-1.5 py-0.5 text-indigo-700 bg-indigo-100 rounded text-xxs font-bold">LOCAL</span> </p>
                                                <div className="aspect-video bg-gray-900 rounded overflow-hidden relative shadow ring-1 ring-indigo-300">
                                                    <video
                                                        ref={localVideoRef}
                                                        key={localStream.id}
                                                        autoPlay muted playsInline
                                                        className="w-full h-full object-cover"
                                                        onLoadedMetadata={(e) => { e.currentTarget.play().catch(err => console.warn(`${LOG_PREFIX} Local autoplay prevented:`, err))}}
                                                        onError={(e) => console.error(`${LOG_PREFIX} Local video element error:`, e)}
                                                        // No srcObject prop here either (handled by useEffect [localStream])
                                                    />
                                                    {!micEnabled && ( <div className="absolute top-1 right-1 p-0.5 bg-red-600 rounded-full"><MicOff className="w-3 h-3 text-white" /></div> )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Remote Peer Videos - USE THE NEW COMPONENT */}
                                        {Object.entries(remoteStreams)
                                            .filter(([_, stream]) => stream?.active && stream.getTracks().length > 0)
                                            .map(([peerId, stream]) => (
                                                <div key={peerId} /* Key for list item */ >
                                                    <p className="text-xs font-medium text-gray-600 mb-1 ml-1 truncate" title={peerId} > Peer <span className='font-mono text-xs' > { peerId.substring(7, 12) } </span> </p>
                                                    <div className="aspect-video bg-gray-800 rounded overflow-hidden relative shadow" >
                                                        {/* Use the RemoteVideoPlayer component */}
                                                        <RemoteVideoPlayer stream={stream} peerId={peerId} />
                                                    </div>
                                                </div>
                                            ))}

                                        {/* Placeholder Messages (remain the same) */}
                                        {Object.values(remoteStreams).filter(s => s?.active && s.getTracks().length > 0).length === 0 && (cameraEnabled || micEnabled) && ( <p className='text-xs text-gray-500 text-center mt-4 px-2'>Waiting for others...</p> )}
                                        {!(cameraEnabled || micEnabled) && ( <p className='text-xs text-gray-500 text-center mt-4 px-2'>Turn on camera/mic to chat.</p> )}

                                    </div> {/* End Video Previews Container */}
                                </div > // End Video Chat Sidebar
                            )
                        }

                    </div > { /* End Body Flex Container */ }

                </div > { /* End White Card */ }
            </div > { /* End Gray Background */ }
        </AppLayout >
    );
}

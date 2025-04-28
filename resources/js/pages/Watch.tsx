import React, { useState, useEffect, useRef } from 'react';
import YouTube, { YouTubePlayer, YouTubeEvent } from 'react-youtube';
import axios from 'axios';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import { debounce } from 'lodash'; // Import debounce from lodash

interface Room {
  name: string;
  youtube_video_id: string;
}

// Updated interface to match Laravel broadcast format
interface SyncEvent {
  payload: {
    event: 'play' | 'pause' | 'seek';
    time?: number;
  };
  room_name?: string;
  source?: string;
}

// Extend Window interface to include Pusher and Echo
declare global {
  interface Window {
    Pusher: typeof Pusher;
    Echo: Echo<any>;
  }
}

export default function Watch({ room }: { room: Room }) {
  const [videoId] = useState<string | null>(new URL(room.youtube_video_id).searchParams.get('v'));
  const [player, setPlayer] = useState<YouTubePlayer | null>(null);
  const [syncEnabled, setSyncEnabled] = useState<boolean>(true);
  const [syncSource, setSyncSource] = useState<string | null>(null);

  // Use useRef to store the debounced sync function
  const debouncedSync = useRef(
    debounce((event: 'play' | 'pause' | 'seek', time: number | null = null, source: string | null) => {
      // Don't send sync if not enabled
      if (!syncEnabled) return;

      console.log(`Sending sync event: ${event}${time !== null ? ` at time: ${time}` : ''}`);

      axios.post(`/api/rooms/${room.name}/sync`, {
        event,
        time,
        source: source // Send source ID to avoid self-events
      })
        .then(response => {
          console.log('Sync successful:', response);
        })
        .catch(error => {
          console.error('Sync failed:', error);
        });
    }, 500) // Debounce for 500ms
  ).current;

  useEffect(() => {
    console.log('Setting up Echo with room:', room.name);

    // For debugging
    window.Pusher = Pusher;
    Pusher.logToConsole = true;

    window.Echo = new Echo({
      broadcaster: 'pusher',
      key: import.meta.env.VITE_PUSHER_APP_KEY,
      cluster: import.meta.env.VITE_PUSHER_APP_CLUSTER,
      forceTLS: true
    });

    // Generate a unique source ID before subscribing
    const sourceId = `client-${Math.random().toString(36).substring(2, 10)}`;
    setSyncSource(sourceId);
    console.log('Set sync source ID:', sourceId);

    // Subscribe to a public channel to avoid authentication issues
    const channelName = `public-room.${room.name}`;
    console.log('Subscribing to channel:', channelName);
    const channel = window.Echo.channel(channelName);

    // Add verbose debugging
    channel.listen('*', (eventName: string, data: any) => {
      console.log(`Received event '${eventName}':`, data);
    });

    // Listen for both formats of the sync event
    // 1. The Laravel broadcast format with leading dot
    channel.listen('.sync', (data: SyncEvent) => {
      console.log('Received .sync event:', data);
      handleSyncEvent(data);
    });

    // 2. Direct Pusher trigger format without leading dot
    channel.listen('sync', (data: SyncEvent) => {
      console.log('Received sync event:', data);
      handleSyncEvent(data);
    });

    // Function to handle sync event data
    const handleSyncEvent = (data: SyncEvent) => {
      if (!data || !data.payload) {
        console.error('Invalid sync event data:', data);
        return;
      }

      // Check if this is our own event by comparing source IDs
      if (data.source === sourceId) {
        console.log('Ignoring event from our own source:', sourceId);
        return;
      }

      const { event, time } = data.payload;

      // Check if player exists and sync is enabled
      if (!player || !syncEnabled) return;

      try {
        if (event === 'play') {
          console.log('Playing video from sync event');
          player.playVideo();
        } else if (event === 'pause') {
          console.log('Pausing video from sync event');
          player.pauseVideo();
        } else if (event === 'seek' && time !== undefined) {
          console.log(`Seeking to ${time} from sync event`);
          player.seekTo(time, true);
        }
      } catch (error) {
        console.error('Error applying video sync:', error);
      }
    };

    console.log('Channel subscribed:', channel);

    return () => {
      console.log('Cleaning up Echo subscription');
      window.Echo.leaveChannel(channelName);
      debouncedSync.cancel(); // Cancel any pending debounced calls on unmount
    };
  }, [player, room.name]);

  const onReady = (e: YouTubeEvent) => {
    console.log('YouTube player ready');
    setPlayer(e.target);
  };

  const sync = (event: 'play' | 'pause' | 'seek', time: number | null = null) => {
    debouncedSync(event, time, syncSource);
  };

  return (
    <div className="p-4">
      <p>Room: <strong>{room.name}</strong></p>

      <div className="mb-4">
        <label className="flex items-center">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={() => setSyncEnabled(!syncEnabled)}
            className="mr-2"
          />
          Enable video synchronization
        </label>
      </div>

      <YouTube
        videoId={videoId || ''}
        onReady={onReady}
        onPlay={() => sync('play')}
        onPause={() => sync('pause')}
        onStateChange={(e: YouTubeEvent) => e.data === 3 && sync('seek', e.target.getCurrentTime())}
        opts={{
          playerVars: {
            autoplay: 0,
          }
        }}
      />
    </div>
  );
}

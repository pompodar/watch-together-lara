<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class WebRTCSignalEvent implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public string $room_name;
    public array $signal; // ['type', 'data', 'source', 'target']

    /**
     * Create a new event instance.
     */
    public function __construct(string $room_name, array $signal)
    {
        $this->room_name = $room_name;
        $this->signal = $signal;
    }

    /**
     * Get the channels the event should broadcast on.
     *
     * @return array<int, \Illuminate\Broadcasting\Channel>
     */
    public function broadcastOn(): array
    {
        // Separate channel for WebRTC signals
        return [
            new Channel('public-room-webrtc.' . $this->room_name),
        ];
    }

    /**
     * The event's broadcast name.
     */
    public function broadcastAs(): string
    {
        return 'signal'; // Matches '.signal' in frontend listener
    }

    /**
     * Get the data to broadcast.
     *
     * @return array<string, mixed>
     */
    public function broadcastWith(): array
    {
        // Send the exact signal structure the frontend expects
        return $this->signal;
    }
}
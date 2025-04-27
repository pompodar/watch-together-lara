<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PresenceChannel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Log;

class VideoSync implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public $payload;
    public $room_name;
    public $source;

    public function __construct($room_name, $payload, $source = 'unknown-source')
    {
        $this->payload = $payload;
        $this->room_name = $room_name;
        $this->source = $source;
        
        // Log the event for debugging
        Log::info('VideoSync event created', [
            'room_name' => $room_name,
            'payload' => $payload,
            'source' => $source
        ]);
    }

    public function broadcastOn(): array
    {
        // Use a public channel to avoid authentication issues
        return [
            new Channel('public-room.' . $this->room_name),
        ];
    }

    public function broadcastAs(): string
    {
        return 'sync';
    }
    
    public function broadcastWith(): array
    {
        return [
            'payload' => $this->payload,
            'room_name' => $this->room_name,
            'source' => $this->source
        ];
    }
}

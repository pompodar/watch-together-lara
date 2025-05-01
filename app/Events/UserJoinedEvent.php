<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PresenceChannel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class UserJoinedEvent implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public $room_name;
    public $room_users;

    /**
     * Create a new event instance.
     *
     * @param string $room_name
     * @param array $room_users
     */
    public function __construct(string $room_name, $room_users)
    {
        $this->room_name = $room_name;
        $this->room_users = $room_users instanceof \Illuminate\Database\Eloquent\Collection ? $room_users->toArray() : $room_users;
    }

    /**
     * Get the channels the event should broadcast on.
     *
     * @return array<int, \Illuminate\Broadcasting\Channel>
     */
    public function broadcastOn(): array
    {
        return [
            new Channel("public-room-users-joined.{$this->room_name}"),
        ];
    }

    public function broadcastWith()
    {
        return $this->room_users;
    }

    /**
     * The event's broadcast name.
     */
    public function broadcastAs(): string
    {
        return 'user-joined';
    }
}

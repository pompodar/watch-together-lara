<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PresenceChannel; // Not used for public, but good practice
use Illuminate\Broadcasting\PrivateChannel; // Not used for public, but good practice
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Str; // For generating unique ID

class ChatMessageSent implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public string $room_name;
    public string $message_text;
    public string $sender_id; // Use snake_case for consistency
    public string $message_id;
    public int $timestamp; // Use milliseconds timestamp (valueOf)

    public function __construct(string $room_name, string $message_text, string $sender_id)
    {
        $this->room_name = $room_name;
        $this->sender_id = $sender_id; // Use snake_case for consistency
        $this->message_text = $message_text;
        $this->sender_id = $sender_id; // Use snake_case for consistency
        $this->message_id = (string) Str::uuid(); // Generate a unique ID for the message
        $this->timestamp = now()->valueOf(); // Get timestamp in milliseconds
    }

    /**
     * Get the channels the event should broadcast on.
     * We use a public channel here.
     *
     * @return \Illuminate\Broadcasting\Channel|array
     */
    public function broadcastOn()
    {
        // Channel name matches the frontend subscription
        return new Channel('public-chat.' . $this->room_name);
    }

    /**
     * The event's broadcast name.
     * Matches the frontend listener name.
     *
     * @return string
     */
    public function broadcastAs()
    {
        return 'new-message';
    }

    /**
     * Get the data to broadcast.
     * This structure should match the `ChatMessage` interface on the frontend.
     *
     * @return array
     */
    public function broadcastWith()
    {
        return [
            'id' => $this->message_id,
            'sender_id' => $this->sender_id,
            'message_text' => $this->message_text,
            'timestamp' => $this->timestamp,
            // Optional: Add senderName if you can resolve it server-side
            // 'senderName' => User::find($this->senderId)?->name ?? 'Peer ' . substr($this->senderId, 7, 5),
        ];
    }
}

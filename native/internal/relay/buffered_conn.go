package relay

import (
	"net"
	"os"
	"sync"
	"time"
)

type readResult struct {
	data []byte
	err  error
}

// bufferedConn gives a WebSocket stream non-destructive read deadlines.
// net/http cancels background reads by setting a deadline in the past. Applying
// that deadline to websocket.NetConn would permanently close the WebSocket,
// breaking HTTP keep-alive after the first request. One bounded read pump owns
// the underlying read; deadline changes interrupt only the consumer.
type bufferedConn struct {
	net.Conn
	reads           chan readResult
	done            chan struct{}
	once            sync.Once
	readMu          sync.Mutex
	pending         []byte
	pendingErr      error
	deadlineMu      sync.Mutex
	deadline        time.Time
	deadlineChanged chan struct{}
}

func newBufferedConn(conn net.Conn) *bufferedConn {
	c := &bufferedConn{Conn: conn, reads: make(chan readResult, 1), done: make(chan struct{}), deadlineChanged: make(chan struct{})}
	go func() {
		for {
			buffer := make([]byte, 32*1024)
			n, err := conn.Read(buffer)
			select {
			case c.reads <- readResult{data: buffer[:n], err: err}:
			case <-c.done:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return c
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if len(c.pending) > 0 {
			n := copy(p, c.pending)
			c.pending = c.pending[n:]
			return n, nil
		}
		if c.pendingErr != nil {
			return 0, c.pendingErr
		}
		c.deadlineMu.Lock()
		deadline, changed := c.deadline, c.deadlineChanged
		c.deadlineMu.Unlock()
		var timer *time.Timer
		var expired <-chan time.Time
		if !deadline.IsZero() {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return 0, os.ErrDeadlineExceeded
			}
			timer = time.NewTimer(remaining)
			expired = timer.C
		}
		select {
		case result := <-c.reads:
			c.pending, c.pendingErr = result.data, result.err
		case <-changed:
		case <-expired:
			return 0, os.ErrDeadlineExceeded
		case <-c.done:
			if timer != nil {
				timer.Stop()
			}
			return 0, net.ErrClosed
		}
		if timer != nil {
			timer.Stop()
		}
	}
}

func (c *bufferedConn) SetReadDeadline(deadline time.Time) error {
	c.deadlineMu.Lock()
	c.deadline = deadline
	close(c.deadlineChanged)
	c.deadlineChanged = make(chan struct{})
	c.deadlineMu.Unlock()
	return nil
}

func (c *bufferedConn) SetDeadline(deadline time.Time) error {
	_ = c.SetReadDeadline(deadline)
	return c.Conn.SetWriteDeadline(deadline)
}

func (c *bufferedConn) Close() error {
	c.once.Do(func() { close(c.done); _ = c.Conn.Close() })
	return nil
}

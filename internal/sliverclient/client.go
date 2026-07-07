package sliverclient

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/bishopfox/sliver/protobuf/clientpb"
	"github.com/bishopfox/sliver/protobuf/commonpb"
	"github.com/bishopfox/sliver/protobuf/rpcpb"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
)

// OperatorConfig mirrors the Sliver operator .cfg JSON.
// Token (added in v1.6+) must be sent as gRPC metadata on every call.
type OperatorConfig struct {
	Operator      string `json:"operator"`
	LHost         string `json:"lhost"`
	LPort         int    `json:"lport"`
	Token         string `json:"token"`
	CACertificate string `json:"ca_certificate"`
	PrivateKey    string `json:"private_key"`
	Certificate   string `json:"certificate"`
}

// Client holds the live connection to a Sliver teamserver.
type Client struct {
	conn   *grpc.ClientConn
	RPC    rpcpb.SliverRPCClient
	Config OperatorConfig
}

// LoadConfig reads an operator .cfg file from disk.
func LoadConfig(path string) (*OperatorConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg OperatorConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return &cfg, nil
}

// Connect dials the teamserver. Two important details vs a naive TLS setup:
//
//  1. InsecureSkipVerify: true  — the server's gRPC cert CN is something like
//     "multiplayer" or the operator name, never "127.0.0.1". Hostname
//     verification would fail silently and kill the handshake. We skip it but
//     keep real CA verification via VerifyPeerCertificate.
//
//  2. Token interceptors — Sliver v1.6+ requires the operator token as an
//     Authorization header on every RPC call, not just mTLS.
func Connect(cfg OperatorConfig) (*Client, error) {
	certPEM := []byte(cfg.Certificate)
	keyPEM := []byte(cfg.PrivateKey)
	caPEM := []byte(cfg.CACertificate)

	clientCert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("load client cert/key: %w", err)
	}

	caPool := x509.NewCertPool()
	if ok := caPool.AppendCertsFromPEM(caPEM); !ok {
		return nil, fmt.Errorf("failed to parse teamserver CA certificate")
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{clientCert},
		// Skip hostname check — server cert CN won't match the IP/host we dial.
		// We compensate with VerifyPeerCertificate below.
		InsecureSkipVerify: true, //nolint:gosec
		// Manually verify the server cert is signed by the teamserver CA.
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return fmt.Errorf("no server certificate received")
			}
			serverCert, err := x509.ParseCertificate(rawCerts[0])
			if err != nil {
				return fmt.Errorf("parse server cert: %w", err)
			}
			opts := x509.VerifyOptions{Roots: caPool}
			if _, err := serverCert.Verify(opts); err != nil {
				return fmt.Errorf("server cert verification failed: %w", err)
			}
			return nil
		},
		MinVersion: tls.VersionTLS12,
	}

	target := fmt.Sprintf("%s:%d", cfg.LHost, cfg.LPort)

	// Generated implants are large (tens of MB); the default 4 MB gRPC receive
	// limit rejects them with ResourceExhausted. Match sliver's own client and
	// allow up to 2 GB in either direction.
	const maxMsgSize = 2 * 1024 * 1024 * 1024

	dialOpts := []grpc.DialOption{
		grpc.WithTransportCredentials(credentials.NewTLS(tlsConfig)),
		grpc.WithBlock(),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(maxMsgSize),
			grpc.MaxCallSendMsgSize(maxMsgSize),
		),
	}

	// Inject operator token on every call (v1.6+ requirement).
	if cfg.Token != "" {
		dialOpts = append(dialOpts,
			grpc.WithUnaryInterceptor(func(ctx context.Context, method string,
				req, reply interface{}, cc *grpc.ClientConn,
				invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
				ctx = metadata.AppendToOutgoingContext(ctx, "Authorization", "Bearer "+cfg.Token)
				return invoker(ctx, method, req, reply, cc, opts...)
			}),
			grpc.WithStreamInterceptor(func(ctx context.Context, desc *grpc.StreamDesc,
				cc *grpc.ClientConn, method string, streamer grpc.Streamer,
				opts ...grpc.CallOption) (grpc.ClientStream, error) {
				ctx = metadata.AppendToOutgoingContext(ctx, "Authorization", "Bearer "+cfg.Token)
				return streamer(ctx, desc, cc, method, opts...)
			}),
		)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	conn, err := grpc.DialContext(ctx, target, dialOpts...) //nolint:staticcheck
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", target, err)
	}

	return &Client{
		conn:   conn,
		RPC:    rpcpb.NewSliverRPCClient(conn),
		Config: cfg,
	}, nil
}

// Close tears down the gRPC connection.
func (c *Client) Close() error {
	if c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

func (c *Client) ListSessions(ctx context.Context) ([]*clientpb.Session, error) {
	resp, err := c.RPC.GetSessions(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	return resp.Sessions, nil
}

func (c *Client) ListOperators(ctx context.Context) ([]*clientpb.Operator, error) {
	resp, err := c.RPC.GetOperators(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	return resp.Operators, nil
}

func (c *Client) ListHTTPC2Profiles(ctx context.Context) ([]*clientpb.HTTPC2Config, error) {
	resp, err := c.RPC.GetHTTPC2Profiles(ctx, &commonpb.Empty{})
	if err != nil {
		return nil, err
	}
	return resp.Configs, nil
}

func (c *Client) GenerateImplant(ctx context.Context, req *clientpb.GenerateReq) (*clientpb.Generate, error) {
	longCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	return c.RPC.Generate(longCtx, req)
}

func (c *Client) RenameSession(ctx context.Context, sessionID string, newName string) error {
	_, err := c.RPC.Rename(ctx, &clientpb.RenameReq{
		SessionID: sessionID,
		Name:      newName,
	})
	return err
}

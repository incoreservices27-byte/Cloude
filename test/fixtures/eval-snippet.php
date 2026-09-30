<?php
/**
 * Parses the generated snippet the way Code Snippets does — eval() on a body
 * with its PHP tags removed. Prints OK when it compiles; runtime errors are not
 * interesting here, only whether it parses.
 */

define( 'ABSPATH', __DIR__ );

function add_action() {}
function apply_filters( $hook, $value ) { return $value; }

$code = file_get_contents( $argv[1] );
$mode = isset( $argv[2] ) ? $argv[2] : 'strip-leading';

if ( 'strip-all' === $mode ) {
	// The aggressive normalisation: every PHP tag removed, anywhere.
	$body = preg_replace( '/<\?(?:php|=)?|\?>/', '', $code );
} elseif ( 'as-is' === $mode ) {
	// Already tag-free; pasted verbatim.
	$body = $code;
} else {
	$body = preg_replace( '/^\s*<\?php\s*/', '', $code, 1 );
}

try {
	eval( $body );
	echo "OK\n";
} catch ( ParseError $e ) {
	echo 'PARSE_ERROR: ' . $e->getMessage() . "\n";
	exit( 1 );
} catch ( Throwable $e ) {
	echo 'OK (runtime: ' . get_class( $e ) . ")\n";
}

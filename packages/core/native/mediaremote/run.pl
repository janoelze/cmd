# Runs one function of the MediaRemote adapter (vendored from
# github.com/ungive/mediaremote-adapter at 797729d, BSD 3-Clause, see LICENSE) in
# /usr/bin/perl: a system binary macOS lets read Now Playing, which an app can't
# since macOS 15.4. Usage: perl run.pl <libmediaremote.dylib> stream | send <command id> | seek <µs>.
# Options go in MEDIAREMOTEADAPTER_OPTION_* (set by the core, nowplaying/adapter.ts).

use strict;
use warnings;
use DynaLoader;

my %param = (send => "command", seek => "position");
my ($lib, $fn, $arg) = @ARGV;
die "usage: run.pl LIB stream | send ID | seek MICROS\n" unless $lib && $fn && ($fn eq "stream" || ($param{$fn} && defined $arg));
$ENV{"MEDIAREMOTEADAPTER_PARAM_adapter_${fn}_0_$param{$fn}"} = "$arg" if $param{$fn};
my $handle = DynaLoader::dl_load_file($lib, 0) or die "can't load $lib\n";
my $symbol = DynaLoader::dl_find_symbol($handle, "adapter_${fn}_env") or die "no adapter_${fn}_env in $lib\n";
DynaLoader::dl_install_xsub("main::run", $symbol);
run();

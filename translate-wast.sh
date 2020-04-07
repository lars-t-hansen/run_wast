JS=~/m-c/js/src/build-debug/dist/bin/js
for fn in $@; do
    outfn=$(dirname $fn)/$(basename $fn .wast).js
    $JS -e "var INPUT_FILE=\"$fn\";" $(dirname $0)/translate-wast.js > $outfn
done
